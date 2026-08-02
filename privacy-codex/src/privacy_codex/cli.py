from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .artifacts import (
    ArtifactStore,
    ensure_runs_root,
    purge_runs,
    validate_sensitive_artifact_configuration,
)
from .comparator import compare_trials, load_trials, safe_trial_dict, write_reports
from .config import AppConfig, load_config
from .edge_detector import train_edge_model_from_jsonl
from .errors import PrivacyCodexError
from .evaluator import (
    EvaluationConfig,
    Evaluator,
    load_eval_cases,
    validate_evaluation_safety,
)
from .io import load_inputs, read_text_file
from .models import Action, EntityType
from .pipeline import PipelineTrialExecutor, PrivacyPipeline
from .policy import PolicyEngine
from .runner import CodexRunner

_FROZEN_ENGLISH_DATASET_SHA256 = (
    "c68aeafa3885930ec3be9f1cde1281da1da88bd6ec2614df9dc13142c406ed2c"
)
_MAX_EVALUATION_MANIFEST_BYTES = 256 * 1024


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="privacy-codex",
        description="Local English privacy wrapper for Codex CLI",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    redact = subparsers.add_parser(
        "redact", help="detect and redact a document/query locally"
    )
    _add_input_arguments(redact)
    _add_detector_arguments(redact)
    redact.add_argument("--policy", type=Path)
    redact.add_argument("--output", type=Path)
    redact.set_defaults(handler=_handle_redact)

    run = subparsers.add_parser(
        "run", help="redact locally, invoke isolated Codex, and restore authorized tokens"
    )
    _add_input_arguments(run)
    _add_detector_arguments(run)
    run.add_argument("--policy", type=Path)
    run.add_argument("--keep-redacted", action="store_true")
    run.add_argument("--allow-sensitive-logs", action="store_true")
    run.add_argument("--timeout", type=float, default=None)
    run.add_argument("--runs-dir", type=Path, default=None)
    run.set_defaults(handler=_handle_run)

    evaluate = subparsers.add_parser(
        "evaluate", help="run baseline/system/oracle benchmark trials"
    )
    _add_detector_arguments(evaluate)
    evaluate.add_argument("--dataset", type=Path, required=True)
    evaluate.add_argument("--repeats", type=int, default=3)
    evaluate.add_argument(
        "--variants",
        default="baseline,system,oracle",
        help="comma-separated subset of baseline,system,oracle",
    )
    evaluate.add_argument("--allow-unredacted-baseline", action="store_true")
    evaluate.add_argument("--allow-sensitive-logs", action="store_true")
    evaluate.add_argument("--timeout", type=float, default=None)
    evaluate.add_argument("--runs-dir", type=Path, default=None)
    evaluate.add_argument("--policy", type=Path)
    evaluate.add_argument("--seed", type=int, default=20260726)
    evaluate.add_argument(
        "--split",
        choices=("dev", "test", "all"),
        default="test",
        help="dataset split to evaluate; final reports default to frozen test cases",
    )
    evaluate.set_defaults(handler=_handle_evaluate)

    compare = subparsers.add_parser(
        "compare", help="rebuild aggregate reports from safe trial metrics"
    )
    compare.add_argument("--run", type=Path, required=True)
    compare.add_argument("--formats", default="json,csv,html")
    compare.set_defaults(handler=_handle_compare)

    purge = subparsers.add_parser("purge", help="delete expired run artifacts")
    purge.add_argument("--older-than", default="7d")
    purge.add_argument("--runs-dir", type=Path, default=Path("runs"))
    purge.set_defaults(handler=_handle_purge)

    train_detector = subparsers.add_parser(
        "train-detector", help="train a compact local non-generative detector"
    )
    train_detector.add_argument("--dataset", type=Path, required=True)
    train_detector.add_argument("--output", type=Path, required=True)
    train_detector.add_argument(
        "--split", choices=("dev", "test", "all"), default="dev"
    )
    train_detector.add_argument("--epochs", type=int, default=8)
    train_detector.set_defaults(handler=_handle_train_detector)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        return int(arguments.handler(arguments))
    except (PrivacyCodexError, ValueError, OSError) as error:
        print(f"privacy-codex: {error}", file=sys.stderr)
        return 2


def _add_input_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--document", type=Path)
    query = parser.add_mutually_exclusive_group()
    query.add_argument("--query-file", type=Path)
    query.add_argument("--query-stdin", action="store_true")
    parser.add_argument(
        "--known-values",
        type=Path,
        help="local JSON mapping of entity types to known values",
    )


def _add_detector_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path)
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--model-digest")
    parser.add_argument("--edge-model-path", type=Path)
    parser.add_argument("--edge-model-digest")
    parser.add_argument(
        "--allow-rules-only",
        action="store_true",
        help="explicitly permit deterministic-only POC mode; live default fails closed",
    )


def _handle_redact(arguments: argparse.Namespace) -> int:
    config = _effective_config(arguments)
    pipeline = _build_pipeline(config, arguments, live=False)
    pipeline.preflight_detectors()
    loaded = _load_cli_inputs(arguments, config)
    known_values = _load_known_values(
        arguments.known_values,
        max_bytes=config.runtime.max_input_bytes,
    )
    if arguments.policy:
        pipeline.policy = _load_policy(arguments.policy, pipeline.policy)
    redaction = pipeline.redact(loaded, known_values=known_values)
    if arguments.output:
        _secure_write_text(arguments.output, redaction.prompt)
        print(str(arguments.output.resolve()))
    else:
        sys.stdout.write(redaction.prompt)
        if not redaction.prompt.endswith("\n"):
            sys.stdout.write("\n")
    return 0


def _handle_run(arguments: argparse.Namespace) -> int:
    config = _effective_config(arguments, live=True)
    pipeline = _build_pipeline(config, arguments, live=True)
    if arguments.policy:
        pipeline.policy = _load_policy(arguments.policy, pipeline.policy)
    runs_dir = arguments.runs_dir or config.runtime.runs_dir
    store = ArtifactStore(
        runs_dir,
        allow_sensitive_logs=arguments.allow_sensitive_logs,
    )
    base_manifest = {
        "versions": pipeline.version_metadata(),
        "detectors": pipeline.detector_descriptors(),
        "status": "preflight_pending",
    }
    runtime_manifest = dict(base_manifest)
    store.write_manifest(base_manifest)
    try:
        pipeline.preflight_detectors()
        assert pipeline.runner is not None
        runner_preflight = pipeline.runner.preflight()
        runtime_manifest = {
            **base_manifest,
            "codex_cli_actual": runner_preflight["cli_version"],
            "status": "preflight_complete",
        }
        store.write_manifest(runtime_manifest)
    except (PrivacyCodexError, ValueError, OSError) as error:
        category = _safe_error_category(error)
        store.record_stage(
            "preflight_failure",
            0,
            duration_ms=0.0,
            error_category=category,
        )
        store.write_metrics(
            {"run_id": store.run_id, "succeeded": False, "failure": category}
        )
        store.write_manifest(
            {**runtime_manifest, "status": "failed", "failure": category}
        )
        print(f"safe artifacts: {store.paths.root}", file=sys.stderr)
        raise
    load_started = time.perf_counter()
    try:
        loaded = _load_cli_inputs(arguments, config)
        known_values = _load_known_values(
            arguments.known_values,
            max_bytes=config.runtime.max_input_bytes,
        )
    except (PrivacyCodexError, ValueError, OSError) as error:
        category = _safe_error_category(error)
        store.record_stage(
            "input_load_failure",
            0,
            duration_ms=(time.perf_counter() - load_started) * 1000,
            error_category=category,
        )
        store.write_metrics(
            {"run_id": store.run_id, "succeeded": False, "failure": category}
        )
        store.write_manifest(
            {**runtime_manifest, "status": "failed", "failure": category}
        )
        print(f"safe artifacts: {store.paths.root}", file=sys.stderr)
        raise
    store.record_stage(
        "input_load",
        0,
        duration_ms=(time.perf_counter() - load_started) * 1000,
    )
    try:
        result = pipeline.run(
            loaded,
            known_values=known_values,
            artifact_store=store,
            keep_redacted=arguments.keep_redacted,
        )
    except (PrivacyCodexError, ValueError, OSError) as error:
        category = _safe_error_category(error)
        store.record_stage(
            "pipeline_failure",
            99,
            duration_ms=0.0,
            error_category=category,
        )
        store.write_metrics(
            {
                "run_id": store.run_id,
                "succeeded": False,
                "failure": category,
            }
        )
        store.write_manifest(
            {**runtime_manifest, "status": "failed", "failure": category}
        )
        print(f"safe artifacts: {store.paths.root}", file=sys.stderr)
        raise
    metrics = {
        "run_id": store.run_id,
        "succeeded": result.agent.succeeded,
        "failure": result.agent.failure,
        "timings": result.timings,
        "usage": result.agent.usage,
        "prompt_size": {
            "prompt_characters": len(result.redaction.prompt),
            "source_characters": sum(
                result.redaction.result.source_lengths.values()
            ),
            "redacted_source_characters": sum(
                len(value)
                for value in result.redaction.result.redacted_sources.values()
            ),
            "character_delta": sum(
                len(value)
                for value in result.redaction.result.redacted_sources.values()
            )
            - sum(result.redaction.result.source_lengths.values()),
        },
        "entity_counts": result.redaction.result.safe_dict()["entity_counts"],
        "output_findings": len(result.output_findings),
        "restoration": {
            "restored_count": result.restoration.restored_count,
            "unknown_token_count": len(result.restoration.unknown_tokens),
            "mutated_token_count": len(result.restoration.mutated_tokens),
        },
    }
    store.write_metrics(metrics)
    store.write_manifest(
        {
            **runtime_manifest,
            "status": "complete" if result.agent.succeeded else "failed",
            "failure": result.agent.failure,
        }
    )
    if not result.agent.succeeded:
        print(
            f"Codex run failed safely ({result.agent.failure}); artifacts: {store.paths.root}",
            file=sys.stderr,
        )
        return 1
    sys.stdout.write(result.restored_output)
    if result.restored_output and not result.restored_output.endswith("\n"):
        sys.stdout.write("\n")
    print(f"safe artifacts: {store.paths.root}", file=sys.stderr)
    return 0


def _handle_evaluate(arguments: argparse.Namespace) -> int:
    config = _effective_config(arguments, live=True)
    if arguments.allow_sensitive_logs:
        validate_sensitive_artifact_configuration()
    pipeline = _build_pipeline(config, arguments, live=True)
    if arguments.policy:
        pipeline.policy = _load_policy(arguments.policy, pipeline.policy)
    all_cases = load_eval_cases(arguments.dataset)
    variants = tuple(
        value.strip() for value in arguments.variants.split(",") if value.strip()
    )
    evaluation_config = EvaluationConfig(
        repeats=arguments.repeats,
        variants=variants,
        allow_unredacted_baseline=arguments.allow_unredacted_baseline,
        seed=arguments.seed,
    )
    if "baseline" in variants:
        _validate_frozen_baseline_dataset(arguments.dataset)
    cases = [
        case
        for case in all_cases
        if arguments.split == "all" or case.split == arguments.split
    ]
    if not cases:
        raise ValueError("the requested evaluation split contains no cases")
    validate_evaluation_safety(cases, evaluation_config)
    pipeline.preflight_detectors()
    assert pipeline.runner is not None
    runner_preflight = pipeline.runner.preflight()

    runs_dir = arguments.runs_dir or config.runtime.runs_dir
    evaluation_root = _new_evaluation_root(runs_dir)
    trials_root = evaluation_root / "trials"
    trials_root.mkdir(mode=0o700)
    executor = PipelineTrialExecutor(
        pipeline,
        runs_dir=trials_root,
        allow_sensitive_logs=arguments.allow_sensitive_logs,
        dataset_sha256=_sha256_file(arguments.dataset),
        dataset_split=arguments.split,
    )
    evaluator = Evaluator(executor, evaluation_config)
    trials, case_metrics = evaluator.run(cases)
    trial_payload = "\n".join(
        json.dumps(safe_trial_dict(trial), sort_keys=True, separators=(",", ":"))
        for trial in trials
    )
    _secure_write_text(evaluation_root / "trials.jsonl", trial_payload + "\n")
    _secure_write_text(
        evaluation_root / "case-metrics.json",
        json.dumps([asdict(item) for item in case_metrics], indent=2, sort_keys=True)
        + "\n",
    )
    summary = compare_trials(
        trials,
        seed=arguments.seed,
        expected_variants=variants,
        expected_repeats=arguments.repeats,
        expected_case_ids=[case.case_id for case in cases],
    )
    report_paths = write_reports(
        evaluation_root / "report",
        summary,
        trials,
        case_metrics,
        formats=("json", "csv", "html"),
    )
    manifest = {
        "artifact_schema": "privacy-codex/evaluation/v1",
        "run_id": evaluation_root.name,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "dataset_sha256": _sha256_file(arguments.dataset),
        "dataset_case_count": len(cases),
        "dataset_source_case_count": len(all_cases),
        "dataset_split": arguments.split,
        "case_ids": [case.case_id for case in cases],
        "frozen_dataset_sha256": (
            _FROZEN_ENGLISH_DATASET_SHA256 if "baseline" in variants else None
        ),
        "variants": variants,
        "repeats": arguments.repeats,
        "seed": arguments.seed,
        "model": config.codex.model,
        "reasoning_effort": config.codex.reasoning_effort,
        "gateway": config.codex.base_url,
        "codex_cli_version": config.codex.required_version,
        "policy_version": pipeline.policy.version,
        "versions": pipeline.version_metadata(),
        "detectors": pipeline.detector_descriptors(),
        "codex_cli_actual": runner_preflight["cli_version"],
        "trial_artifact_count": len(executor.run_paths),
        "status": (
            "complete"
            if summary["incomplete_trial_count"] == 0
            else "incomplete"
        ),
    }
    _secure_write_text(
        evaluation_root / "manifest.json",
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    )
    print(str(evaluation_root.resolve()))
    print(
        json.dumps(
            {
                "completed": summary["completed_trial_count"],
                "incomplete": summary["incomplete_trial_count"],
                "reports": {key: str(value) for key, value in report_paths.items()},
            },
            sort_keys=True,
        )
    )
    return 0 if summary["incomplete_trial_count"] == 0 else 1


def _handle_compare(arguments: argparse.Namespace) -> int:
    trials = load_trials(arguments.run)
    manifest = _load_evaluation_manifest(arguments.run)
    observed_seeds = {
        trial.evaluation_seed
        for trial in trials
        if trial.evaluation_seed is not None
    }
    if len(observed_seeds) > 1:
        raise ValueError("trials disagree about the evaluation seed")
    seed = manifest.get("seed")
    if seed is None:
        seed = next(iter(observed_seeds), 20260726)
    elif observed_seeds and next(iter(observed_seeds)) != seed:
        raise ValueError("manifest and trials disagree about the evaluation seed")
    expected_variants = manifest.get("variants")
    expected_repeats = manifest.get("repeats")
    expected_case_ids = manifest.get("case_ids")
    summary = compare_trials(
        trials,
        seed=_validated_seed(seed),
        expected_variants=expected_variants,
        expected_repeats=expected_repeats,
        expected_case_ids=expected_case_ids,
    )
    report_dir = (
        arguments.run / "report"
        if arguments.run.is_dir()
        else arguments.run.parent / "report"
    )
    formats = tuple(item.strip() for item in arguments.formats.split(",") if item.strip())
    paths = write_reports(report_dir, summary, trials, formats=formats)
    print(json.dumps({key: str(path.resolve()) for key, path in paths.items()}, sort_keys=True))
    return 0


def _handle_purge(arguments: argparse.Namespace) -> int:
    removed = purge_runs(arguments.runs_dir, older_than=arguments.older_than)
    print(json.dumps({"removed": removed, "count": len(removed)}, sort_keys=True))
    return 0


def _handle_train_detector(arguments: argparse.Namespace) -> int:
    if arguments.epochs < 1 or arguments.epochs > 100:
        raise ValueError("epochs must be between 1 and 100")
    split = None if arguments.split == "all" else arguments.split
    digest = train_edge_model_from_jsonl(
        arguments.dataset,
        arguments.output,
        split=split,
        epochs=arguments.epochs,
    )
    print(json.dumps({"model": str(arguments.output.resolve()), "sha256": digest}))
    return 0


def _effective_config(
    arguments: argparse.Namespace,
    *,
    live: bool = False,
) -> AppConfig:
    config = load_config(getattr(arguments, "config", None))
    detector_settings = config.detectors
    model_path = getattr(arguments, "model_path", None)
    if model_path is not None:
        detector_settings = replace(
            detector_settings,
            classifier_model_path=model_path.resolve(),
        )
    edge_model_path = getattr(arguments, "edge_model_path", None)
    if edge_model_path is not None:
        detector_settings = replace(
            detector_settings,
            edge_model_path=edge_model_path.resolve(),
            edge_model_digest=(
                getattr(arguments, "edge_model_digest", None)
                or detector_settings.edge_model_digest
            ),
            edge_model_required=True,
            require_classifier=False,
        )
    timeout = getattr(arguments, "timeout", None)
    codex = config.codex
    if timeout is not None:
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        codex = replace(codex, timeout_seconds=timeout)
    if live:
        codex = replace(
            codex,
            preflight_gateway=True,
        )
    return replace(config, detectors=detector_settings, codex=codex)


def _build_pipeline(
    config: AppConfig,
    arguments: argparse.Namespace,
    *,
    live: bool,
) -> PrivacyPipeline:
    runner = CodexRunner(config.codex) if live else None
    return PrivacyPipeline.from_config(
        config,
        allow_rules_only=bool(arguments.allow_rules_only),
        runner=runner,
        expected_model_digest=(
            getattr(arguments, "model_digest", None)
            or config.detectors.classifier_model_digest
        ),
        edge_model_digest=(
            getattr(arguments, "edge_model_digest", None)
            or config.detectors.edge_model_digest
        ),
    )


def _load_cli_inputs(
    arguments: argparse.Namespace,
    config: AppConfig,
):
    query_stream = None
    if arguments.query_stdin:
        query_stream = sys.stdin
    elif arguments.query_file is None:
        if not sys.stdin.isatty():
            query_stream = sys.stdin
        else:
            query = input("Query (single line): ")
            from io import StringIO

            query_stream = StringIO(query)
    return load_inputs(
        document_path=arguments.document,
        query_file=arguments.query_file,
        query_stream=query_stream,
        max_bytes=config.runtime.max_input_bytes,
        language="en",
    )


def _load_known_values(
    path: Path | None,
    *,
    max_bytes: int,
) -> dict[str, list[str]]:
    if path is None:
        return {}
    if path.suffix.casefold() != ".json":
        raise ValueError("known-values input must be a JSON file")
    raw = json.loads(read_text_file(path, max_bytes=max_bytes))
    if not isinstance(raw, dict):
        raise ValueError("known-values JSON must be an object")
    values: dict[str, list[str]] = {}
    supported_entities = {item.value for item in EntityType}
    for key, items in raw.items():
        entity = str(key).upper()
        if entity not in supported_entities:
            raise ValueError("known-values contains an unsupported entity type")
        if isinstance(items, str):
            resolved_items = [items]
        elif isinstance(items, list) and all(
            isinstance(item, str) for item in items
        ):
            resolved_items = list(items)
        else:
            raise ValueError("known-values entries must be strings or string arrays")
        if not resolved_items or any(not item.strip() for item in resolved_items):
            raise ValueError("known-values entries must not be empty")
        values[entity] = resolved_items
    return values


def _load_policy(path: Path, fallback: PolicyEngine) -> PolicyEngine:
    suffix = path.suffix.casefold()
    if suffix not in {".json", ".toml"}:
        raise ValueError("policy input must be a JSON or TOML file")
    policy_text = read_text_file(path, max_bytes=1_000_000)
    if suffix == ".json":
        raw = json.loads(policy_text)
    else:
        import tomllib

        raw = tomllib.loads(policy_text)
    if not isinstance(raw, dict):
        raise ValueError("policy input must contain an object or table")
    if "policy" in raw and isinstance(raw["policy"], dict):
        raw = raw["policy"]
    actions = {
        str(key).upper(): Action(str(value).upper())
        for key, value in dict(raw.get("actions", {})).items()
    }
    thresholds = {
        str(key).upper(): float(value)
        for key, value in dict(raw.get("thresholds", fallback.thresholds)).items()
    }
    return PolicyEngine(
        version=str(raw.get("version", fallback.version)),
        actions=actions,
        thresholds=thresholds,
    )


def _new_evaluation_root(runs_dir: Path) -> Path:
    ensure_runs_root(runs_dir)
    identifier = (
        datetime.now(timezone.utc).strftime("eval-%Y%m%dT%H%M%S")
        + "-"
        + os.urandom(5).hex()
    )
    root = runs_dir / identifier
    root.mkdir(mode=0o700)
    _secure_write_text(
        root / "manifest.json",
        json.dumps(
            {
                "artifact_schema": "privacy-codex/evaluation/v1",
                "run_id": identifier,
                "created_at": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
                "status": "in_progress",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    return root


def _secure_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        payload = value.encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        descriptor = -1
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_frozen_baseline_dataset(path: Path) -> None:
    if _sha256_file(path) != _FROZEN_ENGLISH_DATASET_SHA256:
        raise ValueError(
            "baseline evaluation requires the frozen generated English corpus"
        )


def _load_evaluation_manifest(path: Path) -> dict[str, Any]:
    manifest_path = (
        path / "manifest.json"
        if path.is_dir()
        else path.parent / "manifest.json"
    )
    if not manifest_path.is_file():
        return {}
    with manifest_path.open("rb") as handle:
        payload = handle.read(_MAX_EVALUATION_MANIFEST_BYTES + 1)
    if len(payload) > _MAX_EVALUATION_MANIFEST_BYTES:
        raise ValueError("evaluation manifest exceeds the supported size")
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("evaluation manifest is not valid UTF-8 JSON") from error
    if not isinstance(raw, dict):
        raise ValueError("evaluation manifest must be a JSON object")
    if raw.get("artifact_schema") != "privacy-codex/evaluation/v1":
        raise ValueError("evaluation manifest has an unsupported schema")
    variants = raw.get("variants")
    if variants is not None and (
        not isinstance(variants, list)
        or not all(isinstance(item, str) for item in variants)
    ):
        raise ValueError("evaluation manifest variants are invalid")
    case_ids = raw.get("case_ids")
    if case_ids is not None and (
        not isinstance(case_ids, list)
        or not all(isinstance(item, str) for item in case_ids)
    ):
        raise ValueError("evaluation manifest case ids are invalid")
    return raw


def _validated_seed(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("evaluation seed must be an integer")
    return value


def _safe_error_category(error: Exception) -> str:
    import re

    return re.sub(
        r"(?<!^)(?=[A-Z])", "_", type(error).__name__
    ).lower().removesuffix("_error")


if __name__ == "__main__":
    raise SystemExit(main())
