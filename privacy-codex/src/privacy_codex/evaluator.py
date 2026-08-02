from __future__ import annotations

import json
import math
import random
import re
import statistics
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from .errors import EvaluationSafetyError, PrivacyCodexError
from .models import Action, CaseMetrics, Decision, EvalCase, Span, TrialResult

_MAX_EVALUATION_DATASET_BYTES = 16 * 1024 * 1024
_MAX_EVALUATION_CASE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class EvaluationConfig:
    repeats: int = 3
    variants: tuple[str, ...] = ("baseline", "system", "oracle")
    allow_unredacted_baseline: bool = False
    seed: int = 20260726

    def __post_init__(self) -> None:
        allowed = {"baseline", "system", "oracle"}
        if (
            not isinstance(self.repeats, int)
            or isinstance(self.repeats, bool)
            or self.repeats < 1
        ):
            raise ValueError("evaluation repeats must be positive")
        if not isinstance(self.seed, int) or isinstance(self.seed, bool):
            raise ValueError("evaluation seed must be an integer")
        if not self.variants or set(self.variants).difference(allowed):
            raise ValueError("evaluation variants must be baseline, system, or oracle")
        if len(set(self.variants)) != len(self.variants):
            raise ValueError("evaluation variants must not contain duplicates")


class TrialExecutor(Protocol):
    def __call__(
        self,
        case: EvalCase,
        variant: str,
        repeat: int,
        order: int,
    ) -> TrialResult: ...


class Evaluator:
    def __init__(
        self,
        executor: TrialExecutor,
        config: EvaluationConfig | None = None,
    ) -> None:
        self.executor = executor
        self.config = config or EvaluationConfig()

    def run(
        self, cases: Sequence[EvalCase]
    ) -> tuple[list[TrialResult], list[CaseMetrics]]:
        validate_evaluation_safety(cases, self.config)
        jobs = [
            (case, variant, repeat)
            for case in cases
            for repeat in range(1, self.config.repeats + 1)
            for variant in self.config.variants
        ]
        random.Random(self.config.seed).shuffle(jobs)
        trials: list[TrialResult] = []
        for order, (case, variant, repeat) in enumerate(jobs, start=1):
            try:
                trial = self.executor(case, variant, repeat, order)
            except (PrivacyCodexError, OSError, TimeoutError) as error:
                trial = TrialResult(
                    case_id=case.case_id,
                    variant=variant,
                    repeat=repeat,
                    output="",
                    codex_events=[],
                    usage={},
                    timings={},
                    failure=_safe_failure_category(error),
                    order=order,
                )
            trial.order = order
            trial.domain = case.domain
            trial.difficulty = case.difficulty
            trial.task_type = case.task_type
            trial.split = case.split
            trial.expected_variants = self.config.variants
            trial.expected_repeats = self.config.repeats
            trial.evaluation_seed = self.config.seed
            evaluation_started = time.perf_counter()
            trial.utility = (
                score_utility(case, trial.output)
                if trial.failure is None
                else {"score": 0.0}
            )
            trial.timings["evaluation_ms"] = (
                time.perf_counter() - evaluation_started
            ) * 1000
            trials.append(trial)
        _verify_paired_configuration(trials)
        metrics: list[CaseMetrics] = []
        for case in cases:
            case_trials = [
                trial for trial in trials if trial.case_id == case.case_id
            ]
            incomplete_pairs = _incomplete_pair_count(
                case_trials,
                expected_variants=self.config.variants,
                expected_repeats=self.config.repeats,
            )
            for variant in self.config.variants:
                metrics.append(
                    summarize_case(
                        case,
                        [
                            trial
                            for trial in case_trials
                            if trial.variant == variant
                        ],
                        variant=variant,
                        incomplete_pairs=incomplete_pairs,
                    )
                )
        return trials, metrics


def load_eval_cases(path: Path) -> list[EvalCase]:
    cases: list[EvalCase] = []
    case_ids: set[str] = set()
    total_bytes = 0
    with path.open("rb") as handle:
        line_number = 0
        while True:
            payload = handle.readline(_MAX_EVALUATION_CASE_BYTES + 1)
            if not payload:
                break
            line_number += 1
            total_bytes += len(payload)
            if (
                len(payload) > _MAX_EVALUATION_CASE_BYTES
                or total_bytes > _MAX_EVALUATION_DATASET_BYTES
            ):
                raise ValueError("evaluation dataset exceeds the supported size")
            try:
                line = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(
                    f"invalid evaluation case at JSONL line {line_number}"
                ) from error
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
                case = EvalCase.from_dict(raw)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise ValueError(
                    f"invalid evaluation case at JSONL line {line_number}"
                ) from error
            if case.case_id in case_ids:
                raise ValueError(f"duplicate evaluation case id at line {line_number}")
            if case.language != "en":
                raise ValueError("v1 accepts English evaluation cases only")
            case_ids.add(case.case_id)
            cases.append(case)
    if not cases:
        raise ValueError("evaluation dataset contains no cases")
    return cases


def validate_evaluation_safety(
    cases: Sequence[EvalCase],
    config: EvaluationConfig,
) -> None:
    if any(type(case.synthetic) is not bool or not case.synthetic for case in cases):
        raise EvaluationSafetyError(
            "v1 evaluation is restricted to schema-validated synthetic data"
        )
    if "baseline" in config.variants and not config.allow_unredacted_baseline:
        raise EvaluationSafetyError(
            "unredacted baseline requires --allow-unredacted-baseline even for synthetic data"
        )


def compute_privacy_metrics(
    gold_spans: Sequence[dict[str, Any]],
    predicted_spans: Sequence[Decision | Span | dict[str, Any]],
) -> dict[str, float | int | bool]:
    gold = [
        _span_tuple(item)
        for item in gold_spans
        if str(item.get("action", "TOKENIZE")).upper() != "ALLOW"
    ]
    predicted = [
        _span_tuple(item)
        for item in predicted_spans
        if (
            not isinstance(item, Decision)
            or item.action is not Action.ALLOW
        )
        and (
            not isinstance(item, dict)
            or str(item.get("action", "TOKENIZE")).upper() != "ALLOW"
        )
    ]
    gold_set = set(gold)
    predicted_set = set(predicted)
    exact_tp = len(gold_set.intersection(predicted_set))
    exact_fp = len(predicted_set.difference(gold_set))
    exact_fn = len(gold_set.difference(predicted_set))
    precision, recall, f1 = _prf(exact_tp, exact_fp, exact_fn)

    relaxed_tp, relaxed_fp, relaxed_fn = _relaxed_counts(gold, predicted)
    relaxed_precision, relaxed_recall, relaxed_f1 = _prf(
        relaxed_tp, relaxed_fp, relaxed_fn
    )

    gold_chars = _covered_characters(gold)
    predicted_chars = _covered_characters(predicted)
    covered = len(gold_chars.intersection(predicted_chars))
    char_recall = covered / len(gold_chars) if gold_chars else 1.0
    surviving = len(gold_chars) - covered

    critical = [
        span
        for span in gold
        if span[3]
        in {"PAYMENT_CARD", "CVV", "CREDENTIAL", "PRIVATE_KEY", "UNKNOWN_HIGH_RISK"}
    ]
    critical_chars = _covered_characters(critical)
    critical_covered = len(critical_chars.intersection(predicted_chars))
    critical_leak_rate = (
        (len(critical_chars) - critical_covered) / len(critical_chars)
        if critical_chars
        else 0.0
    )
    return {
        "exact_tp": exact_tp,
        "exact_fp": exact_fp,
        "exact_fn": exact_fn,
        "gold_span_count": len(gold),
        "predicted_span_count": len(predicted),
        "exact_precision": precision,
        "exact_recall": recall,
        "exact_f1": f1,
        "relaxed_tp": relaxed_tp,
        "relaxed_fp": relaxed_fp,
        "relaxed_fn": relaxed_fn,
        "relaxed_precision": relaxed_precision,
        "relaxed_recall": relaxed_recall,
        "relaxed_f1": relaxed_f1,
        "gold_sensitive_characters": len(gold_chars),
        "covered_sensitive_characters": covered,
        "character_recall": char_recall,
        "surviving_sensitive_characters": surviving,
        "prompt_safe": surviving == 0,
        "critical_sensitive_characters": len(critical_chars),
        "critical_surviving_characters": len(critical_chars) - critical_covered,
        "critical_leak_rate": critical_leak_rate,
        "false_positive_redaction_rate": (
            exact_fp / len(predicted_set) if predicted_set else 0.0
        ),
    }


def score_utility(case: EvalCase, output: str) -> dict[str, float | int | bool]:
    if case.task_type == "extraction":
        metrics = structured_field_metrics(case.expected_answer, output)
        score = float(metrics["field_f1"])
        metrics["relationship_preservation"] = float(metrics["field_recall"])
    else:
        metrics = qa_metrics(case.expected_answer, output)
        score = float(metrics["token_f1"])
    required = required_fact_metrics(case.required_facts, output)
    metrics.update(required)
    if case.task_type == "qa":
        metrics["relationship_preservation"] = float(
            required["required_fact_recall"]
        )
    metrics["score"] = (score + float(required["required_fact_recall"])) / 2.0
    if not case.required_facts:
        metrics["score"] = score
        metrics["relationship_preservation"] = score
    return metrics


def qa_metrics(expected: Any, output: str) -> dict[str, float | bool]:
    candidates: list[str]
    if isinstance(expected, list):
        candidates = [str(item) for item in expected]
    elif isinstance(expected, dict) and "answer" in expected:
        answer = expected["answer"]
        candidates = [str(item) for item in answer] if isinstance(answer, list) else [str(answer)]
    else:
        candidates = [str(expected)]
    normalized_output = normalize_answer(output)
    exact = (
        max(
            1.0 if normalized_output == normalize_answer(value) else 0.0
            for value in candidates
        )
        if candidates
        else 0.0
    )
    token_f1 = max(
        (_token_f1(normalized_output, normalize_answer(value)) for value in candidates),
        default=0.0,
    )
    return {"normalized_exact_match": exact, "token_f1": token_f1}


def structured_field_metrics(
    expected: Any,
    output: str,
) -> dict[str, float | int | bool]:
    parsed: Any
    try:
        parsed = json.loads(_strip_json_fence(output))
    except (json.JSONDecodeError, TypeError):
        parsed = {}
    if not isinstance(expected, dict) or not isinstance(parsed, dict):
        return {
            "schema_valid": False,
            "field_exact_match": 0.0,
            "field_precision": 0.0,
            "field_recall": 0.0,
            "field_f1": 0.0,
            "matched_fields": 0,
        }
    expected_flat = _flatten(expected)
    parsed_flat = _flatten(parsed)
    schema_valid = _matches_expected_schema(expected, parsed)
    matched = sum(
        1
        for key, value in expected_flat.items()
        if key in parsed_flat
        and _json_types_compatible(value, parsed_flat[key])
        and normalize_answer(str(parsed_flat[key])) == normalize_answer(str(value))
    )
    false_positive = max(0, len(parsed_flat) - matched)
    false_negative = max(0, len(expected_flat) - matched)
    precision, recall, f1 = _prf(matched, false_positive, false_negative)
    return {
        "schema_valid": schema_valid,
        "field_exact_match": float(
            schema_valid and matched == len(expected_flat) == len(parsed_flat)
        ),
        "field_precision": precision,
        "field_recall": recall,
        "field_f1": f1,
        "matched_fields": matched,
    }


def required_fact_metrics(
    required_facts: Sequence[str],
    output: str,
) -> dict[str, float | int]:
    if not required_facts:
        return {"required_fact_recall": 1.0, "required_facts_found": 0}
    output_tokens = normalize_answer(output).split()
    found = sum(
        1
        for fact in required_facts
        if _contains_token_sequence(
            output_tokens,
            normalize_answer(fact).split(),
        )
    )
    return {
        "required_fact_recall": found / len(required_facts),
        "required_facts_found": found,
    }


def normalize_answer(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = "".join(
        character
        if character.isalnum() or character.isspace()
        else " "
        for character in value
    )
    return " ".join(value.split())


def summarize_case(
    case: EvalCase,
    trials: Sequence[TrialResult],
    *,
    variant: str | None = None,
    incomplete_pairs: int | None = None,
) -> CaseMetrics:
    if variant is None:
        observed_variants = {trial.variant for trial in trials}
        if len(observed_variants) != 1:
            raise ValueError("case metrics must summarize exactly one variant")
        variant = next(iter(observed_variants))
    completed = [trial for trial in trials if trial.failure is None]
    timings: dict[str, float] = {}
    for name in sorted({key for trial in completed for key in trial.timings}):
        values = [float(trial.timings[name]) for trial in completed if name in trial.timings]
        timings[f"{name}_mean"] = statistics.fmean(values) if values else 0.0
    token_metrics: dict[str, float | int] = {}
    for name in sorted({key for trial in completed for key in trial.usage}):
        values = [
            float(trial.usage[name])
            for trial in completed
            if name in trial.usage and isinstance(trial.usage[name], (int, float))
        ]
        token_metrics[f"{name}_mean"] = statistics.fmean(values) if values else 0.0
    privacy_keys = sorted(
        {
            key
            for trial in completed
            for key in trial.privacy
            if isinstance(trial.privacy[key], (int, float, bool))
        }
    )
    privacy: dict[str, float | int | bool] = {}
    for key in privacy_keys:
        values = [float(trial.privacy[key]) for trial in completed if key in trial.privacy]
        privacy[f"{key}_mean"] = statistics.fmean(values) if values else 0.0
    utility_keys = sorted(
        {
            key
            for trial in completed
            for key, value in trial.utility.items()
            if isinstance(value, (int, float, bool))
        }
    )
    utility: dict[str, float | int | bool] = {
        f"{key}_mean": statistics.fmean(
            float(trial.utility[key])
            for trial in completed
            if key in trial.utility
        )
        for key in utility_keys
    }
    utility["completed_trials"] = len(completed)
    return CaseMetrics(
        case_id=case.case_id,
        domain=case.domain,
        difficulty=case.difficulty,
        task_type=case.task_type,
        split=case.split,
        variant=variant,
        privacy=privacy,
        utility=utility,
        restoration={
            "exact_rate_mean": statistics.fmean(
                [
                    float(trial.privacy.get("restoration_exact", 0.0))
                    for trial in completed
                ]
            )
            if completed
            else 0.0
        },
        latency=timings,
        token_metrics=token_metrics,
        incomplete_pairs=(
            incomplete_pairs
            if incomplete_pairs is not None
            else sum(trial.failure is not None for trial in trials)
        ),
    )


def _span_tuple(
    item: Decision | Span | dict[str, Any],
) -> tuple[str, int, int, str]:
    if isinstance(item, Decision):
        item = item.span
    if isinstance(item, Span):
        return (item.source, item.start, item.end, item.entity_type)
    return (
        str(item["source"]),
        int(item["start"]),
        int(item["end"]),
        str(item.get("type") or item.get("entity_type")),
    )


def _relaxed_counts(
    gold: Sequence[tuple[str, int, int, str]],
    predicted: Sequence[tuple[str, int, int, str]],
) -> tuple[int, int, int]:
    unmatched = set(range(len(predicted)))
    matches = 0
    for gold_span in gold:
        candidates = [
            index
            for index in unmatched
            if _overlap(gold_span, predicted[index])
            and gold_span[3] == predicted[index][3]
        ]
        if not candidates:
            continue
        winner = max(
            candidates,
            key=lambda index: _intersection_length(gold_span, predicted[index]),
        )
        unmatched.remove(winner)
        matches += 1
    return matches, len(predicted) - matches, len(gold) - matches


def _covered_characters(
    spans: Sequence[tuple[str, int, int, str]],
) -> set[tuple[str, int]]:
    return {
        (source, position)
        for source, start, end, _ in spans
        for position in range(start, end)
    }


def _overlap(
    left: tuple[str, int, int, str],
    right: tuple[str, int, int, str],
) -> bool:
    return left[0] == right[0] and left[1] < right[2] and right[1] < left[2]


def _intersection_length(
    left: tuple[str, int, int, str],
    right: tuple[str, int, int, str],
) -> int:
    if left[0] != right[0]:
        return 0
    return max(0, min(left[2], right[2]) - max(left[1], right[1]))


def _prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if tp + fp else (1.0 if not fn else 0.0)
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return precision, recall, f1


def _token_f1(left: str, right: str) -> float:
    left_tokens = left.split()
    right_tokens = right.split()
    if not left_tokens or not right_tokens:
        return float(left_tokens == right_tokens)
    counts: dict[str, int] = {}
    for token in right_tokens:
        counts[token] = counts.get(token, 0) + 1
    common = 0
    for token in left_tokens:
        if counts.get(token, 0):
            common += 1
            counts[token] -= 1
    precision = common / len(left_tokens)
    recall = common / len(right_tokens)
    return 2 * precision * recall / (precision + recall) if common else 0.0


def _contains_token_sequence(
    haystack: Sequence[str],
    needle: Sequence[str],
) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    width = len(needle)
    return any(
        list(haystack[index : index + width]) == list(needle)
        for index in range(len(haystack) - width + 1)
    )


def _strip_json_fence(output: str) -> str:
    stripped = output.strip()
    match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else stripped


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, dict):
        flattened: dict[str, Any] = {}
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(_flatten(child, child_prefix))
        return flattened
    if isinstance(value, list):
        flattened = {}
        for index, child in enumerate(value):
            child_prefix = f"{prefix}[{index}]"
            flattened.update(_flatten(child, child_prefix))
        return flattened
    return {prefix: value}


def _matches_expected_schema(expected: Any, parsed: Any) -> bool:
    if isinstance(expected, dict):
        return isinstance(parsed, dict) and all(
            key in parsed and _matches_expected_schema(value, parsed[key])
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(parsed, list)
            and len(parsed) == len(expected)
            and all(
                _matches_expected_schema(expected_item, parsed_item)
                for expected_item, parsed_item in zip(expected, parsed)
            )
        )
    return _json_types_compatible(expected, parsed)


def _json_types_compatible(expected: Any, parsed: Any) -> bool:
    if expected is None:
        return parsed is None
    if isinstance(expected, bool):
        return isinstance(parsed, bool)
    if isinstance(expected, int):
        return isinstance(parsed, int) and not isinstance(parsed, bool)
    if isinstance(expected, float):
        return (
            isinstance(parsed, (int, float))
            and not isinstance(parsed, bool)
            and math.isfinite(float(parsed))
        )
    if isinstance(expected, str):
        return isinstance(parsed, str)
    return type(parsed) is type(expected)


def _verify_paired_configuration(trials: Sequence[TrialResult]) -> None:
    configurations: dict[tuple[str, int], set[str]] = {}
    all_configurations: set[str] = set()
    for trial in trials:
        if trial.failure is not None:
            continue
        if (
            not isinstance(trial.configuration_hash, str)
            or not trial.configuration_hash.strip()
        ):
            raise ValueError("successful trials require a configuration hash")
        score = trial.utility.get("score")
        if (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not math.isfinite(float(score))
            or not 0.0 <= float(score) <= 1.0
        ):
            raise ValueError("successful trials require a finite utility score")
        if any(
            not math.isfinite(float(value))
            for value in trial.utility.values()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ):
            raise ValueError("utility metrics must be finite")
        configurations.setdefault((trial.case_id, trial.repeat), set()).add(
            trial.configuration_hash
        )
        all_configurations.add(trial.configuration_hash)
    if any(len(values) > 1 for values in configurations.values()):
        raise ValueError("paired trials used different Codex configurations")
    if len(all_configurations) > 1:
        raise ValueError("evaluation trials used different Codex configurations")


def _incomplete_pair_count(
    trials: Sequence[TrialResult],
    *,
    expected_variants: Sequence[str],
    expected_repeats: int,
) -> int:
    lookup = {(trial.repeat, trial.variant): trial for trial in trials}
    return sum(
        1
        for repeat in range(1, expected_repeats + 1)
        if any(
            (repeat, variant) not in lookup
            or lookup[(repeat, variant)].failure is not None
            for variant in expected_variants
        )
    )


def _safe_failure_category(error: Exception) -> str:
    name = type(error).__name__
    category = re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
    return category.removesuffix("_error")
