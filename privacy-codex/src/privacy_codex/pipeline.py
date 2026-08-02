from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .artifacts import ArtifactStore, UnsafeArtifactError
from .config import AppConfig
from .detectors import (
    DetectSecretsDetector,
    Detector,
    DetectorOrchestrator,
    KnownValueDetector,
    PrivacyFilterDetector,
    RuleDetector,
)
from .edge_detector import EdgeMLDetector
from .errors import EvaluationSafetyError, InputRejectedError, VerificationError
from .evaluator import compute_privacy_metrics, score_utility
from .io import reject_unsafe_semantic_encodings
from .models import (
    Action,
    AgentResult,
    CRITICAL_ENTITY_TYPES,
    Decision,
    EvalCase,
    LoadedInput,
    RedactionResult,
    Severity,
    Span,
    TextSource,
    TrialResult,
)
from .policy import PolicyEngine
from .prompt import build_prompt
from .runner import CodexRunner
from .tokenizer import (
    RestorationResult,
    TOKEN_PATTERN,
    Tokenizer,
    restore_tokens,
    sensitive_substrings,
    sha256_text,
    verify_redaction,
)


@dataclass
class PipelineRedaction:
    result: RedactionResult
    prompt: str
    timings: dict[str, float]


@dataclass
class PipelineResult:
    redaction: PipelineRedaction
    agent: AgentResult
    redacted_output: str
    restored_output: str
    restoration: RestorationResult
    output_findings: list[Decision]
    timings: dict[str, float]
    run_path: Path | None = None


class PrivacyPipeline:
    def __init__(
        self,
        *,
        detectors: list[Detector],
        policy: PolicyEngine,
        tokenizer: Tokenizer | None = None,
        runner: CodexRunner | None = None,
        detector_timeout_seconds: float = 10.0,
        detector_max_workers: int = 4,
    ) -> None:
        if not detectors:
            raise ValueError("privacy pipeline requires at least one local detector")
        if runner is not None and not any(
            isinstance(detector, RuleDetector) for detector in detectors
        ):
            raise ValueError(
                "a live privacy pipeline requires the deterministic RuleDetector"
            )
        self.detectors = detectors
        self.policy = policy
        self.tokenizer = tokenizer or Tokenizer()
        self.runner = runner
        self.orchestrator = DetectorOrchestrator(
            detectors,
            timeout_seconds=detector_timeout_seconds,
            max_workers=detector_max_workers,
        )

    @classmethod
    def from_config(
        cls,
        config: AppConfig,
        *,
        allow_rules_only: bool = False,
        runner: CodexRunner | None = None,
        classifier_inference: Callable[[str], list[dict[str, Any]]] | None = None,
        expected_model_digest: str | None = None,
        edge_model_digest: str | None = None,
    ) -> PrivacyPipeline:
        detectors: list[Detector] = [
            KnownValueDetector(),
            RuleDetector(),
            DetectSecretsDetector(required=False),
        ]
        require_classifier = config.detectors.require_classifier and not allow_rules_only
        if (
            config.detectors.classifier_model_path is not None
            or classifier_inference is not None
            or require_classifier
        ):
            detectors.append(
                PrivacyFilterDetector(
                    config.detectors.classifier_model_path,
                    required=require_classifier,
                    inference=classifier_inference,
                    expected_digest=expected_model_digest,
                )
            )
        if config.detectors.edge_model_path is not None:
            detectors.append(
                EdgeMLDetector(
                    config.detectors.edge_model_path,
                    required=config.detectors.edge_model_required,
                    expected_digest=(
                        edge_model_digest or config.detectors.edge_model_digest
                    ),
                    threshold=config.detectors.edge_model_threshold,
                )
            )
        return cls(
            detectors=detectors,
            policy=PolicyEngine(
                version=config.policy.version,
                thresholds=config.detectors.thresholds,
            ),
            runner=runner or CodexRunner(config.codex),
            detector_timeout_seconds=config.detectors.classifier_timeout_seconds,
            detector_max_workers=config.detectors.max_workers,
        )

    def preflight_detectors(self) -> dict[str, float]:
        _, timings = self.orchestrator.detect_sources(
            [
                TextSource(
                    name="preflight",
                    text="Local English privacy detector preflight.",
                    language="en",
                )
            ]
        )
        return timings

    def detector_descriptors(self) -> list[dict[str, Any]]:
        descriptors: list[dict[str, Any]] = []
        for detector in self.detectors:
            descriptor: dict[str, Any] = {
                "name": detector.name,
                "required": bool(getattr(detector, "required", True)),
                "version": str(getattr(detector, "version", "poc-v1")),
            }
            model_digest = getattr(detector, "model_digest", None)
            if model_digest is None:
                model_digest = getattr(detector, "_expected_digest", None)
            if isinstance(model_digest, str) and (
                model_digest == "injected"
                or re.fullmatch(r"[0-9a-fA-F]{64}", model_digest.strip())
            ):
                descriptor["model_digest"] = model_digest.strip().casefold()
            descriptors.append(descriptor)
        return descriptors

    def version_metadata(self) -> dict[str, str]:
        policy_payload = json.dumps(
            {
                "actions": {
                    entity: action.value
                    for entity, action in sorted(self.policy.actions.items())
                },
                "thresholds": dict(sorted(self.policy.thresholds.items())),
                "version": self.policy.version,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        versions = {
            "privacy_codex": "0.2.0",
            "policy": self.policy.version,
            "policy_sha256": sha256_text(policy_payload),
            "detectors": ",".join(
                (
                    f"{descriptor['name']}:"
                    f"{'required' if descriptor['required'] else 'optional'}:"
                    f"{descriptor['version']}"
                )
                for descriptor in self.detector_descriptors()
            ),
        }
        for descriptor in self.detector_descriptors():
            model_digest = descriptor.get("model_digest")
            if model_digest is not None:
                versions[f"{descriptor['name']}_model_digest"] = str(model_digest)
        runner_config = getattr(self.runner, "config", None)
        if runner_config is not None:
            versions.update(
                {
                    "codex_cli": str(runner_config.required_version),
                    "gateway": str(runner_config.base_url),
                    "model": str(runner_config.model),
                    "reasoning_effort": str(runner_config.reasoning_effort),
                }
            )
        return versions

    def redact(
        self,
        loaded: LoadedInput,
        *,
        known_values: dict[str, list[str]] | None = None,
        evaluation_mode: bool = False,
        artifact_store: ArtifactStore | None = None,
        oracle_decisions: list[Decision] | None = None,
    ) -> PipelineRedaction:
        started = time.perf_counter()
        sources = _loaded_sources(loaded)
        for source in sources:
            reject_unsafe_semantic_encodings(source.text)
        source_hash = _combined_source_hash(sources)
        if artifact_store is not None:
            artifact_store.record_stage(
                "ingest",
                1,
                duration_ms=0.0,
                input_hash=source_hash,
                output_hash=source_hash,
                versions={**self.version_metadata(), "language": "en"},
            )

        detection_started = time.perf_counter()
        detector_timings: dict[str, float] = {}
        if oracle_decisions is None:
            spans, detector_timings = self.orchestrator.detect_sources(
                sources,
                known_values=known_values,
                evaluation_mode=evaluation_mode,
            )
            spans = _propagate_repeated_detections(sources, spans)
            detection_ms = (time.perf_counter() - detection_started) * 1000
            fusion_started = time.perf_counter()
            decisions = self.policy.resolve(spans)
            fusion_ms = (time.perf_counter() - fusion_started) * 1000
        else:
            decisions = oracle_decisions
            spans = [decision.span for decision in decisions]
            detection_ms = 0.0
            fusion_ms = 0.0

        sensitive_values = sensitive_substrings(sources, decisions)
        if artifact_store is not None:
            artifact_store.register_sensitive_values(sensitive_values)
            artifact_store.record_stage(
                "detection",
                2,
                duration_ms=detection_ms,
                input_hash=source_hash,
                output_hash=_hash_safe_detections(decisions),
                versions=self.version_metadata(),
                entity_counts=_entity_counts(decisions),
                actions=_action_counts(decisions),
            )
            artifact_store.record_stage(
                "span_fusion",
                3,
                duration_ms=fusion_ms,
                input_hash=_hash_safe_spans(spans),
                output_hash=_hash_safe_detections(decisions),
                versions=self.version_metadata(),
                entity_counts=_entity_counts(decisions),
                actions=_action_counts(decisions),
            )

        tokenize_started = time.perf_counter()
        redaction = self.tokenizer.redact(
            sources,
            decisions,
            evaluation_mode=evaluation_mode,
        )
        tokenization_ms = (time.perf_counter() - tokenize_started) * 1000
        prompt = build_prompt(redaction)
        verify_redaction(sources, redaction, final_prompt=prompt)
        if (
            loaded.display_name
            and loaded.display_name in prompt
        ) or (
            loaded.original_path
            and loaded.original_path in prompt
        ):
            raise VerificationError(
                "the original file path or filename survived prompt construction"
            )
        prompt_hash = sha256_text(prompt)
        if artifact_store is not None:
            artifact_store.record_stage(
                "redaction",
                4,
                duration_ms=tokenization_ms,
                input_hash=source_hash,
                output_hash=prompt_hash,
                versions=self.version_metadata(),
                entity_counts=_entity_counts(decisions),
                actions=_action_counts(decisions),
            )
            try:
                artifact_store.write_redacted_prompt(prompt)
            except UnsafeArtifactError:
                if not evaluation_mode:
                    raise VerificationError(
                        "the final prompt failed the independent artifact safety scan"
                    )
                artifact_store.write_redacted_prompt(
                    "[suppressed: the artifact safety scanner found surviving "
                    "labelled sensitive content]\n"
                )
            artifact_store.write_detections(redaction.safe_dict())
            if artifact_store.allow_sensitive_logs:
                artifact_store.write_sensitive(
                    "original-input",
                    json.dumps(
                        {source.name: source.text for source in sources},
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
                artifact_store.write_sensitive(
                    "token-map",
                    json.dumps(redaction.token_map, ensure_ascii=False, sort_keys=True),
                )
        timings = {
            **detector_timings,
            "detection_ms": detection_ms,
            "rule_detection_ms": sum(
                value
                for key, value in detector_timings.items()
                if key.startswith("rule:")
            ),
            "classifier_ms": sum(
                value
                for key, value in detector_timings.items()
                if key.startswith("privacy_filter:")
            ),
            "fusion_ms": fusion_ms,
            "tokenization_ms": tokenization_ms,
            "redaction_ms": (time.perf_counter() - started) * 1000,
        }
        return PipelineRedaction(result=redaction, prompt=prompt, timings=timings)

    def run(
        self,
        loaded: LoadedInput,
        *,
        known_values: dict[str, list[str]] | None = None,
        artifact_store: ArtifactStore | None = None,
        keep_redacted: bool = False,
    ) -> PipelineResult:
        if self.runner is None:
            raise RuntimeError("a Codex runner is required")
        total_started = time.perf_counter()
        redaction = self.redact(
            loaded,
            known_values=known_values,
            artifact_store=artifact_store,
        )
        agent = self.runner.run(redaction.prompt)
        if artifact_store is not None:
            artifact_store.record_stage(
                "codex",
                5,
                duration_ms=agent.timings.get("codex_seconds", 0.0) * 1000,
                input_hash=sha256_text(redaction.prompt),
                output_hash=sha256_text(agent.output),
                versions=self.version_metadata(),
                thread_id=agent.thread_id,
                exit_code=agent.exit_code,
                usage=agent.usage,
                error_category=agent.failure,
            )
            artifact_store.write_codex_events(
                [_safe_event_metadata(event) for event in agent.events]
            )
            if artifact_store.allow_sensitive_logs:
                artifact_store.write_sensitive(
                    "codex-events",
                    json.dumps(agent.events, ensure_ascii=False, sort_keys=True),
                )
        if not agent.succeeded:
            empty_restoration = RestorationResult(
                text="",
                restored_count=0,
                unknown_tokens=[],
                mutated_tokens=[],
            )
            return PipelineResult(
                redaction=redaction,
                agent=agent,
                redacted_output="",
                restored_output="",
                restoration=empty_restoration,
                output_findings=[],
                timings={
                    **redaction.timings,
                    "codex_ms": agent.timings.get("codex_seconds", 0.0) * 1000,
                    "total_ms": (time.perf_counter() - total_started) * 1000,
                },
                run_path=artifact_store.paths.root if artifact_store else None,
            )

        scan_started = time.perf_counter()
        scanned_output, output_findings = self.scan_output(
            agent.output,
            redaction.result.token_map,
        )
        output_scan_ms = (time.perf_counter() - scan_started) * 1000
        restoration_started = time.perf_counter()
        restoration = restore_tokens(
            scanned_output,
            redaction.result.token_map,
            redaction.result.irreversible_tokens,
        )
        restored_output = scanned_output if keep_redacted else restoration.text
        restoration_ms = (time.perf_counter() - restoration_started) * 1000

        if artifact_store is not None:
            artifact_store.register_sensitive_values(redaction.result.token_map.values())
            artifact_store.write_agent_output_redacted(scanned_output)
            if artifact_store.allow_sensitive_logs:
                artifact_store.write_sensitive("restored-output", restoration.text)
            artifact_store.record_stage(
                "output_scan_and_restoration",
                6,
                duration_ms=output_scan_ms + restoration_ms,
                input_hash=sha256_text(agent.output),
                output_hash=sha256_text(restored_output),
                versions=self.version_metadata(),
                entity_counts=_entity_counts(output_findings),
                actions=_action_counts(output_findings),
                error_category=(
                    "token_integrity_failure"
                    if restoration.unknown_tokens or restoration.mutated_tokens
                    else None
                ),
            )
        timings = {
            **redaction.timings,
            "codex_ms": agent.timings.get("codex_seconds", 0.0) * 1000,
            "output_scan_ms": output_scan_ms,
            "restoration_ms": restoration_ms,
            "total_ms": (time.perf_counter() - total_started) * 1000,
        }
        return PipelineResult(
            redaction=redaction,
            agent=agent,
            redacted_output=scanned_output,
            restored_output=restored_output,
            restoration=restoration,
            output_findings=output_findings,
            timings=timings,
            run_path=artifact_store.paths.root if artifact_store else None,
        )

    def scan_output(
        self,
        output: str,
        token_map: dict[str, str],
    ) -> tuple[str, list[Decision]]:
        try:
            reject_unsafe_semantic_encodings(output)
        except InputRejectedError:
            finding = Decision(
                span=Span(
                    source="output",
                    start=0,
                    end=len(output),
                    entity_type="UNKNOWN_HIGH_RISK",
                    confidence=1.0,
                    detector="semantic_output_guard",
                    severity=Severity.CRITICAL,
                    validated=True,
                ),
                action=Action.REMOVE,
                reason="the model emitted an unsafe semantic encoding",
            )
            return "__OUTPUT_REDACTED_UNKNOWN_HIGH_RISK__", [finding]

        mapped_findings: list[Decision] = []
        for token, original in token_map.items():
            if not original:
                continue
            entity_match = re.fullmatch(
                r"__PII_(?P<entity>[A-Z0-9_]+)_[A-Z0-9]{8,}__", token
            )
            entity = (
                entity_match.group("entity")
                if entity_match is not None
                else "UNKNOWN_HIGH_RISK"
            )
            for match in list(re.finditer(re.escape(original), output)):
                mapped_findings.append(
                    Decision(
                        span=Span(
                            source="output",
                            start=match.start(),
                            end=match.end(),
                            entity_type=entity,
                            confidence=1.0,
                            detector="mapped_value_leak",
                            severity=Severity.HIGH,
                            validated=True,
                        ),
                        action=Action.REMOVE,
                        reason="the model emitted an original mapped value",
                    )
                )
            if original in output:
                output = output.replace(original, "__OUTPUT_MAPPED_VALUE_LEAK__")
        spans, _ = self.orchestrator.detect_sources(
            [TextSource(name="output", text=output, language="en")]
        )
        decisions = self.policy.resolve(spans)
        replacements: list[tuple[int, int, str]] = []
        new_findings: list[Decision] = []
        for decision in decisions:
            if decision.action is Action.ALLOW:
                continue
            value = output[decision.span.start : decision.span.end]
            if value in token_map or TOKEN_PATTERN.fullmatch(value):
                continue
            marker = f"__OUTPUT_REDACTED_{decision.span.entity_type}__"
            replacements.append((decision.span.start, decision.span.end, marker))
            new_findings.append(decision)
        masked = output
        for start, end, marker in sorted(replacements, reverse=True):
            masked = masked[:start] + marker + masked[end:]
        return masked, mapped_findings + new_findings


class PipelineTrialExecutor:
    def __init__(
        self,
        pipeline: PrivacyPipeline,
        *,
        runs_dir: Path | None = None,
        allow_sensitive_logs: bool = False,
        artifact_environ: dict[str, str] | None = None,
        dataset_sha256: str | None = None,
        dataset_split: str | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.runs_dir = runs_dir
        self.allow_sensitive_logs = allow_sensitive_logs
        self.artifact_environ = artifact_environ
        self.dataset_sha256 = dataset_sha256
        self.dataset_split = dataset_split
        self.run_paths: list[Path] = []

    def __call__(
        self,
        case: EvalCase,
        variant: str,
        repeat: int,
        order: int,
    ) -> TrialResult:
        started = time.perf_counter()
        loaded = LoadedInput(
            query=TextSource("query", case.query, case.language),
            document=TextSource("document", case.document, case.language),
        )
        loading_ms = (time.perf_counter() - started) * 1000
        store = self._new_store(case, variant, repeat)
        redaction: PipelineRedaction
        if variant == "baseline":
            redaction = _baseline_redaction(loaded)
            if store is not None:
                source_hash = _combined_source_hash(_loaded_sources(loaded))
                store.record_stage(
                    "baseline_ingest",
                    1,
                    duration_ms=loading_ms,
                    input_hash=source_hash,
                    output_hash=source_hash,
                    versions={**self.pipeline.version_metadata(), "language": "en"},
                )
                store.record_stage(
                    "baseline_detection_skipped",
                    2,
                    duration_ms=0.0,
                    input_hash=source_hash,
                    output_hash=source_hash,
                    versions=self.pipeline.version_metadata(),
                )
                store.record_stage(
                    "baseline_fusion_skipped",
                    3,
                    duration_ms=0.0,
                    input_hash=source_hash,
                    output_hash=source_hash,
                    versions=self.pipeline.version_metadata(),
                )
                store.record_stage(
                    "baseline_passthrough",
                    4,
                    duration_ms=0.0,
                    input_hash=source_hash,
                    output_hash=sha256_text(redaction.prompt),
                    versions={
                        **self.pipeline.version_metadata(),
                        "authorization": "frozen_synthetic_baseline",
                    },
                )
                if store.allow_sensitive_logs:
                    store.write_sensitive(
                        "original-input",
                        _serialized_input(loaded),
                    )
        elif variant == "oracle":
            redaction = self.pipeline.redact(
                loaded,
                evaluation_mode=True,
                artifact_store=store,
                oracle_decisions=oracle_decisions(case),
            )
        elif variant == "system":
            redaction = self.pipeline.redact(
                loaded,
                evaluation_mode=True,
                artifact_store=store,
            )
        else:
            raise ValueError(f"unknown evaluation variant {variant}")

        if self.pipeline.runner is None:
            raise RuntimeError("evaluation requires a Codex runner")
        agent = self.pipeline.runner.run(redaction.prompt)
        if store is not None:
            store.record_stage(
                "codex",
                5,
                duration_ms=agent.timings.get("codex_seconds", 0.0) * 1000,
                input_hash=sha256_text(redaction.prompt),
                output_hash=sha256_text(agent.output),
                versions=self.pipeline.version_metadata(),
                thread_id=agent.thread_id,
                exit_code=agent.exit_code,
                usage=agent.usage,
                error_category=agent.failure,
            )
        privacy = compute_privacy_metrics(
            case.gold_spans,
            [] if variant == "baseline" else redaction.result.decisions,
        )
        privacy["per_entity"] = _per_entity_privacy(
            case.gold_spans,
            [] if variant == "baseline" else redaction.result.decisions,
        )
        output = agent.output
        restoration_exact = 1.0
        output_leak_rate = 0.0
        output_scan_ms = 0.0
        restoration_ms = 0.0
        output_findings: list[Decision] = []
        token_integrity_failure = False
        if agent.succeeded and variant != "baseline":
            output_scan_started = time.perf_counter()
            scanned, output_findings = self.pipeline.scan_output(
                output, redaction.result.token_map
            )
            output_scan_ms = (time.perf_counter() - output_scan_started) * 1000
            restoration_started = time.perf_counter()
            restoration = restore_tokens(
                scanned,
                redaction.result.token_map,
                redaction.result.irreversible_tokens,
            )
            restoration_ms = (time.perf_counter() - restoration_started) * 1000
            output = restoration.text
            known_occurrences = sum(
                agent.output.count(token) for token in redaction.result.token_map
            )
            restoration_exact = float(
                not restoration.unknown_tokens
                and not restoration.mutated_tokens
                and restoration.restored_count == known_occurrences
            )
            token_integrity_failure = bool(
                restoration.unknown_tokens or restoration.mutated_tokens
            )
            output_leak_rate = float(bool(output_findings))
            if store is not None:
                store.write_agent_output_redacted(scanned)
                if store.allow_sensitive_logs:
                    store.write_sensitive("restored-output", output)
        elif agent.succeeded and store is not None and store.allow_sensitive_logs:
            store.write_sensitive("baseline-output", output)

        privacy.update(
            {
                "restoration_exact": restoration_exact,
                "output_leak_rate": output_leak_rate,
                "token_collision_failure": False,
                "pseudonym_consistency": _pseudonym_consistency(
                    case, redaction.result
                ),
            }
        )
        timings = {
            **redaction.timings,
            "loading_ms": loading_ms,
            "codex_ms": agent.timings.get("codex_seconds", 0.0) * 1000,
            "output_scan_ms": output_scan_ms,
            "restoration_ms": restoration_ms,
            "total_ms": (time.perf_counter() - started) * 1000,
        }
        usage = {
            **agent.usage,
            "prompt_characters": len(redaction.prompt),
            "source_characters": sum(redaction.result.source_lengths.values()),
            "redacted_source_characters": sum(
                len(value)
                for value in redaction.result.redacted_sources.values()
            ),
            "prompt_character_delta": sum(
                len(value)
                for value in redaction.result.redacted_sources.values()
            )
            - sum(redaction.result.source_lengths.values()),
        }
        evaluation_started = time.perf_counter()
        utility = (
            score_utility(case, output)
            if agent.succeeded
            else {"score": 0.0}
        )
        timings["evaluation_ms"] = (
            time.perf_counter() - evaluation_started
        ) * 1000
        if store is not None:
            store.write_codex_events(
                [_safe_event_metadata(event) for event in agent.events]
            )
            if store.allow_sensitive_logs:
                store.write_sensitive(
                    "codex-events",
                    json.dumps(agent.events, ensure_ascii=False, sort_keys=True),
                )
            output_stage = (
                "output_scan_and_restoration"
                if agent.succeeded and variant != "baseline"
                else (
                    "baseline_output_capture"
                    if agent.succeeded
                    else "output_scan_skipped"
                )
            )
            store.record_stage(
                output_stage,
                6,
                duration_ms=output_scan_ms + restoration_ms,
                input_hash=sha256_text(agent.output),
                output_hash=sha256_text(output),
                versions=self.pipeline.version_metadata(),
                entity_counts=_entity_counts(output_findings),
                actions=_action_counts(output_findings),
                error_category=(
                    "token_integrity_failure"
                    if token_integrity_failure
                    else agent.failure
                ),
            )
            store.write_metrics(
                {
                    "case_id": case.case_id,
                    "variant": variant,
                    "repeat": repeat,
                    "privacy": privacy,
                    "utility": utility,
                    "timings": timings,
                    "usage": usage,
                    "failure": agent.failure,
                }
            )
        return TrialResult(
            case_id=case.case_id,
            variant=variant,
            repeat=repeat,
            output=output,
            codex_events=agent.events,
            usage=usage,
            timings=timings,
            privacy=privacy,
            utility=utility,
            failure=agent.failure,
            configuration_hash=_configuration_hash(self.pipeline.runner),
            order=order,
            domain=case.domain,
            difficulty=case.difficulty,
            task_type=case.task_type,
        )

    def _new_store(
        self, case: EvalCase, variant: str, repeat: int
    ) -> ArtifactStore | None:
        if self.runs_dir is None:
            return None
        safe_case = re.sub(r"[^A-Za-z0-9._-]", "_", case.case_id)
        run_id = f"{safe_case}-{variant}-r{repeat}-{os.urandom(4).hex()}"
        store = ArtifactStore(
            self.runs_dir,
            run_id=run_id,
            allow_sensitive_logs=self.allow_sensitive_logs,
            environ=self.artifact_environ,
            sensitive_values=_case_sensitive_values(case),
        )
        store.write_manifest(
            {
                "case_id": case.case_id,
                "variant": variant,
                "repeat": repeat,
                "dataset_sha256": self.dataset_sha256,
                "dataset_split": self.dataset_split or case.split,
                "case_split": case.split,
                "configuration_hash": _configuration_hash(self.pipeline.runner),
                "versions": self.pipeline.version_metadata(),
                "detectors": self.pipeline.detector_descriptors(),
            }
        )
        self.run_paths.append(store.paths.root)
        return store


def oracle_decisions(case: EvalCase) -> list[Decision]:
    decisions: list[Decision] = []
    sources = {"query": case.query, "document": case.document}
    expected_actions = PolicyEngine().actions
    for gold in case.gold_spans:
        source = gold.get("source")
        entity = gold.get("type")
        start = gold.get("start")
        end = gold.get("end")
        raw_action = gold.get("action", "TOKENIZE")
        if (
            source not in sources
            or not isinstance(entity, str)
            or not entity
            or not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start < 0
            or end <= start
            or end > len(sources[source])
            or not isinstance(raw_action, str)
        ):
            raise EvaluationSafetyError("oracle gold span is malformed")
        entity = entity.upper()
        try:
            action = Action(raw_action.upper())
        except ValueError as error:
            raise EvaluationSafetyError("oracle gold action is invalid") from error
        required_action = expected_actions.get(entity, Action.BLOCK)
        if action is not required_action:
            raise EvaluationSafetyError(
                f"oracle action for {entity} must be {required_action.value}"
            )
        severity = (
            Severity.CRITICAL
            if entity in CRITICAL_ENTITY_TYPES
            else Severity.HIGH
        )
        span = Span(
            source=source,
            start=start,
            end=end,
            entity_type=entity,
            confidence=1.0,
            detector="oracle",
            severity=severity,
            validated=True,
            metadata={
                "coreference_group": gold.get("coreference_group", "")
            },
        )
        decisions.append(
            Decision(span=span, action=action, reason="gold oracle annotation")
        )
    return sorted(decisions, key=lambda item: (item.span.source, item.span.start))


def _baseline_redaction(loaded: LoadedInput) -> PipelineRedaction:
    sources = _loaded_sources(loaded)
    result = RedactionResult(
        redacted_sources={source.name: source.text for source in sources},
        token_map={},
        detections=[],
        decisions=[],
        source_hashes={source.name: sha256_text(source.text) for source in sources},
        redacted_hashes={source.name: sha256_text(source.text) for source in sources},
        language="en",
        source_lengths={source.name: len(source.text) for source in sources},
    )
    return PipelineRedaction(
        result=result,
        prompt=build_prompt(result),
        timings={"redaction_ms": 0.0},
    )


def _loaded_sources(loaded: LoadedInput) -> list[TextSource]:
    sources = [loaded.query]
    if loaded.document is not None:
        sources.append(loaded.document)
    return sources


def _propagate_repeated_detections(
    sources: list[TextSource],
    spans: list[Span],
) -> list[Span]:
    """Extend a confirmed value to exact repeats in every request source.

    This is deterministic coreference propagation, not semantic inference. It
    closes the common case where a labelled value in a document is repeated
    without a label in the query.
    """

    source_text = {source.name: source.text for source in sources}
    existing = {
        (span.source, span.start, span.end, span.entity_type) for span in spans
    }
    propagated = list(spans)
    for span in spans:
        if span.entity_type in {"PUBLIC_ENTITY", "NONSENSITIVE_ID"}:
            continue
        value = source_text[span.source][span.start : span.end]
        if len(value.strip()) < 3 or TOKEN_PATTERN.fullmatch(value):
            continue
        flags = (
            re.IGNORECASE
            if span.entity_type in {"PERSON", "EMAIL"}
            else 0
        )
        pattern = re.compile(re.escape(value), flags)
        for source in sources:
            for match in pattern.finditer(source.text):
                key = (source.name, match.start(), match.end(), span.entity_type)
                if key in existing:
                    continue
                if (
                    value[0].isalnum()
                    and match.start() > 0
                    and source.text[match.start() - 1].isalnum()
                ):
                    continue
                if (
                    value[-1].isalnum()
                    and match.end() < len(source.text)
                    and source.text[match.end()].isalnum()
                ):
                    continue
                existing.add(key)
                propagated.append(
                    Span(
                        source=source.name,
                        start=match.start(),
                        end=match.end(),
                        entity_type=span.entity_type,
                        confidence=span.confidence,
                        detector="cross_source_repeat",
                        severity=span.severity,
                        validated=True,
                        private=span.private,
                        metadata={
                            "propagated_from_source": span.source,
                            "propagated_from_detector": span.detector,
                        },
                    )
                )
    return propagated


def _combined_source_hash(sources: list[TextSource]) -> str:
    digest = hashlib.sha256()
    for source in sources:
        digest.update(source.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.text.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _hash_safe_detections(decisions: list[Decision]) -> str:
    payload = json.dumps(
        [decision.safe_dict() for decision in decisions],
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256_text(payload)


def _hash_safe_spans(spans: list[Span]) -> str:
    payload = json.dumps(
        [span.safe_dict() for span in spans],
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256_text(payload)


def _entity_counts(decisions: list[Decision]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for decision in decisions:
        counts[decision.span.entity_type] = counts.get(decision.span.entity_type, 0) + 1
    return counts


def _action_counts(decisions: list[Decision]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for decision in decisions:
        counts[decision.action.value] = counts.get(decision.action.value, 0) + 1
    return counts


def _safe_event_metadata(event: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(event, ensure_ascii=False, sort_keys=True).encode("utf-8")
    raw_type = event.get("type")
    event_type = (
        raw_type
        if isinstance(raw_type, str)
        and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}", raw_type)
        else "unknown"
    )
    return {
        "type": event_type,
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "byte_length": len(encoded),
        "payload_suppressed": True,
    }


def _pseudonym_consistency(case: EvalCase, result: RedactionResult) -> float:
    grouped: dict[str, set[str]] = {}
    sources = {"query": case.query, "document": case.document}
    for gold in case.gold_spans:
        group = str(gold.get("coreference_group", ""))
        if not group or str(gold.get("action", "TOKENIZE")).upper() != "TOKENIZE":
            continue
        source = sources[str(gold["source"])]
        value = source[int(gold["start"]) : int(gold["end"])]
        tokens = {
            token for token, original in result.token_map.items() if original == value
        }
        grouped.setdefault(group, set()).update(tokens)
    if not grouped:
        return 1.0
    return sum(1.0 for tokens in grouped.values() if len(tokens) == 1) / len(grouped)


def _configuration_hash(runner: CodexRunner) -> str:
    config = runner.config
    value = {
        "required_version": config.required_version,
        "model": config.model,
        "reasoning_effort": config.reasoning_effort,
        "base_url": config.base_url,
        "allowed_gateway_hosts": list(config.allowed_gateway_hosts),
        "timeout_seconds": config.timeout_seconds,
        "tool_configuration": "codex-0.131.0-all-capabilities-disabled-v2",
    }
    return sha256_text(json.dumps(value, sort_keys=True))


def _case_sensitive_values(case: EvalCase) -> list[str]:
    values: list[str] = []
    sources = {"query": case.query, "document": case.document}
    for gold in case.gold_spans:
        source = sources[str(gold["source"])]
        values.append(source[int(gold["start"]) : int(gold["end"])])
    return values


def _serialized_input(loaded: LoadedInput) -> str:
    return json.dumps(
        {
            "query": loaded.query.text,
            "document": loaded.document.text if loaded.document else None,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _per_entity_privacy(
    gold_spans: list[dict[str, Any]],
    predicted: list[Decision],
) -> dict[str, dict[str, float | int | bool]]:
    result: dict[str, dict[str, float | int | bool]] = {}
    entities = {str(span["type"]) for span in gold_spans}
    entities.update(
        decision.span.entity_type
        for decision in predicted
        if decision.action is not Action.ALLOW
    )
    for entity in sorted(entities):
        result[entity] = compute_privacy_metrics(
            [span for span in gold_spans if str(span["type"]) == entity],
            [
                decision
                for decision in predicted
                if decision.span.entity_type == entity
            ],
        )
    return result
