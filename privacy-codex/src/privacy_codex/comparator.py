from __future__ import annotations

import csv
import html
import json
import math
import os
import random
import re
import statistics
import tempfile
from pathlib import Path
from typing import Any, Iterable, Sequence

from .models import (
    SAFE_METADATA_PATTERN,
    CaseMetrics,
    TrialResult,
)

_MAX_TRIAL_FILE_BYTES = 64 * 1024 * 1024
_MAX_TRIAL_RECORD_BYTES = 2 * 1024 * 1024


def compare_trials(
    trials: Sequence[TrialResult],
    *,
    bootstrap_samples: int = 2_000,
    seed: int = 20260726,
    expected_variants: Sequence[str] | None = None,
    expected_repeats: int | None = None,
    expected_case_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    resolved_variants, resolved_repeats = _resolve_expectations(
        trials,
        expected_variants=expected_variants,
        expected_repeats=expected_repeats,
    )
    _validate_trial_keys(
        trials,
        expected_variants=resolved_variants,
        expected_repeats=resolved_repeats,
        expected_case_ids=expected_case_ids,
    )
    completed = [trial for trial in trials if trial.failure is None]
    variants: dict[str, list[TrialResult]] = {}
    for trial in completed:
        variants.setdefault(trial.variant, []).append(trial)
    variant_summary = {
        variant: _variant_summary(items)
        for variant, items in sorted(variants.items())
    }
    comparisons: dict[str, Any] = {}
    for protected in ("system", "oracle"):
        key = f"{protected}_vs_baseline"
        pairs = _paired_trials(completed, protected, "baseline")
        comparisons[key] = _comparison(
            pairs,
            bootstrap_samples=bootstrap_samples,
            seed=seed + (1 if protected == "system" else 2),
        )
    system_oracle = _paired_trials(completed, "system", "oracle")
    comparisons["system_vs_oracle"] = _comparison(
        system_oracle,
        bootstrap_samples=bootstrap_samples,
        seed=seed + 3,
    )
    incomplete = _incomplete_trials(
        trials,
        expected_variants=resolved_variants,
        expected_repeats=resolved_repeats,
        expected_case_ids=expected_case_ids,
    )
    return {
        "schema_version": "privacy-codex-report-v1",
        "expected_variants": list(resolved_variants),
        "expected_repeats": resolved_repeats,
        "expected_case_count": len(
            set(expected_case_ids)
            if expected_case_ids is not None
            else {trial.case_id for trial in trials}
        ),
        "trial_count": len(trials),
        "completed_trial_count": len(completed),
        "incomplete_trial_count": len(incomplete),
        "variants": variant_summary,
        "comparisons": comparisons,
        "slices": {
            "domain": _slice_summaries(completed, "domain"),
            "difficulty": _slice_summaries(completed, "difficulty"),
            "task_type": _slice_summaries(completed, "task_type"),
            "split": _slice_summaries(completed, "split"),
        },
        "incomplete_trials": incomplete,
    }


def write_reports(
    report_dir: Path,
    summary: dict[str, Any],
    trials: Sequence[TrialResult],
    case_metrics: Sequence[CaseMetrics] = (),
    *,
    formats: Iterable[str] = ("json", "csv", "html"),
) -> dict[str, Path]:
    requested = {item.lower() for item in formats}
    unknown = requested.difference({"json", "csv", "html"})
    if unknown:
        raise ValueError("report formats must be json, csv, or html")
    _prepare_report_directory(report_dir)
    outputs: dict[str, Path] = {}
    if "json" in requested:
        path = report_dir / "summary.json"
        _secure_write(
            path,
            json.dumps(
                _json_safe(summary),
                indent=2,
                sort_keys=True,
                allow_nan=False,
            )
            + "\n",
        )
        outputs["json"] = path
    if "csv" in requested:
        path = report_dir / "cases.csv"
        _write_csv(path, trials, case_metrics)
        outputs["csv"] = path
    if "html" in requested:
        path = report_dir / "report.html"
        _secure_write(path, _render_html(summary))
        outputs["html"] = path
    return outputs


def load_trials(path: Path) -> list[TrialResult]:
    source = path
    if path.is_dir():
        source = path / "trials.jsonl"
    trials: list[TrialResult] = []
    total_bytes = 0
    with source.open("rb") as handle:
        line_number = 0
        while True:
            payload = handle.readline(_MAX_TRIAL_RECORD_BYTES + 1)
            if not payload:
                break
            line_number += 1
            total_bytes += len(payload)
            if (
                len(payload) > _MAX_TRIAL_RECORD_BYTES
                or total_bytes > _MAX_TRIAL_FILE_BYTES
            ):
                raise ValueError("trial JSONL exceeds the supported size")
            try:
                line = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(f"invalid trial JSONL line {line_number}") from error
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
                if not isinstance(raw, dict):
                    raise TypeError("trial record must be a JSON object")
                raw_expected_variants = raw.get("expected_variants", [])
                if not isinstance(raw_expected_variants, list) or not all(
                    isinstance(item, str) for item in raw_expected_variants
                ):
                    raise TypeError("expected_variants must be a string array")
                raw_expected_repeats = raw.get("expected_repeats")
                if raw_expected_repeats is not None and (
                    not isinstance(raw_expected_repeats, int)
                    or isinstance(raw_expected_repeats, bool)
                ):
                    raise TypeError("expected_repeats must be an integer")
                trials.append(
                    TrialResult(
                        case_id=raw["case_id"],
                        variant=raw["variant"],
                        repeat=raw["repeat"],
                        output="",
                        codex_events=[],
                        usage=dict(raw.get("usage", {})),
                        timings=dict(raw.get("timings", {})),
                        privacy=dict(raw.get("privacy", {})),
                        utility=dict(raw.get("utility", {})),
                        failure=raw.get("failure"),
                        configuration_hash=raw.get("configuration_hash"),
                        order=raw.get("order"),
                        domain=raw.get("domain"),
                        difficulty=raw.get("difficulty"),
                        task_type=raw.get("task_type"),
                        split=raw.get("split"),
                        expected_variants=tuple(raw_expected_variants),
                        expected_repeats=raw_expected_repeats,
                        evaluation_seed=raw.get("evaluation_seed"),
                    )
                )
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise ValueError(f"invalid trial JSONL line {line_number}") from error
    return trials


def safe_trial_dict(trial: TrialResult) -> dict[str, Any]:
    return {
        "case_id": trial.case_id,
        "variant": trial.variant,
        "repeat": trial.repeat,
        "usage": trial.usage,
        "timings": trial.timings,
        "privacy": trial.privacy,
        "utility": trial.utility,
        "failure": (
            _safe_failure_label(trial.failure) if trial.failure is not None else None
        ),
        "configuration_hash": trial.configuration_hash,
        "order": trial.order,
        "domain": trial.domain,
        "difficulty": trial.difficulty,
        "task_type": trial.task_type,
        "split": trial.split,
        "expected_variants": list(trial.expected_variants),
        "expected_repeats": trial.expected_repeats,
        "evaluation_seed": trial.evaluation_seed,
    }


def paired_bootstrap_ci(
    deltas_by_case: dict[str, list[float]],
    *,
    samples: int = 2_000,
    seed: int = 20260726,
) -> tuple[float, float]:
    if not deltas_by_case:
        return math.nan, math.nan
    case_values = [
        statistics.fmean(values)
        for values in deltas_by_case.values()
        if values
    ]
    if not case_values:
        return math.nan, math.nan
    rng = random.Random(seed)
    estimates = [
        statistics.fmean(rng.choice(case_values) for _ in case_values)
        for _ in range(samples)
    ]
    estimates.sort()
    return percentile(estimates, 2.5), percentile(estimates, 97.5)


def percentile(values: Sequence[float], percentage: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentage / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _variant_summary(trials: Sequence[TrialResult]) -> dict[str, Any]:
    utility = [float(trial.utility.get("score", 0.0)) for trial in trials]
    summary: dict[str, Any] = {
        "count": len(trials),
        "utility_mean": statistics.fmean(utility) if utility else math.nan,
        "utility_median": statistics.median(utility) if utility else math.nan,
    }
    utility_keys = sorted(
        {
            key
            for trial in trials
            for key, value in trial.utility.items()
            if isinstance(value, (int, float, bool))
        }
    )
    summary["utility"] = {
        f"{key}_mean": statistics.fmean(
            float(trial.utility[key])
            for trial in trials
            if key in trial.utility
        )
        for key in utility_keys
    }
    timing_keys = sorted({key for trial in trials for key in trial.timings})
    summary["latency_ms"] = {}
    for key in timing_keys:
        values = [
            float(trial.timings[key])
            for trial in trials
            if key in trial.timings
        ]
        summary["latency_ms"][key] = {
            "p50": percentile(values, 50),
            "p95": percentile(values, 95),
            "p99": percentile(values, 99),
        }
    usage_keys = sorted({key for trial in trials for key in trial.usage})
    summary["usage"] = {
        key: statistics.fmean(
            float(trial.usage[key]) for trial in trials if key in trial.usage
        )
        for key in usage_keys
    }
    summary["privacy"] = _micro_privacy(
        [trial.privacy for trial in trials]
    )
    averaged_privacy_keys = (
        "prompt_safe",
        "pseudonym_consistency",
        "restoration_exact",
        "output_leak_rate",
        "token_collision_failure",
    )
    summary["privacy"].update({
        key: statistics.fmean(
            float(trial.privacy[key])
            for trial in trials
            if key in trial.privacy
        )
        for key in averaged_privacy_keys
        if any(key in trial.privacy for trial in trials)
    })
    entities = sorted(
        {
            entity
            for trial in trials
            for entity in trial.privacy.get("per_entity", {})
        }
    )
    summary["privacy"]["per_entity"] = {}
    for entity in entities:
        entity_records = [
            trial.privacy["per_entity"][entity]
            for trial in trials
            if entity in trial.privacy.get("per_entity", {})
        ]
        entity_summary = _micro_privacy(entity_records)
        if any("prompt_safe" in record for record in entity_records):
            entity_summary["prompt_safe"] = statistics.fmean(
                float(record["prompt_safe"])
                for record in entity_records
                if "prompt_safe" in record
            )
        summary["privacy"]["per_entity"][entity] = entity_summary
    return summary


def _micro_privacy(records: Sequence[dict[str, Any]]) -> dict[str, float | int]:
    summary: dict[str, float | int] = {}
    exact_records = [
        record
        for record in records
        if all(key in record for key in ("exact_tp", "exact_fp", "exact_fn"))
    ]
    if exact_records:
        tp = sum(int(record["exact_tp"]) for record in exact_records)
        fp = sum(int(record["exact_fp"]) for record in exact_records)
        fn = sum(int(record["exact_fn"]) for record in exact_records)
        precision, recall, f1 = _prf_counts(tp, fp, fn)
        summary.update(
            {
                "exact_tp": tp,
                "exact_fp": fp,
                "exact_fn": fn,
                "exact_precision": precision,
                "exact_recall": recall,
                "exact_f1": f1,
                "false_positive_redaction_rate": (
                    fp / (tp + fp) if tp + fp else 0.0
                ),
            }
        )
    else:
        for key in (
            "exact_precision",
            "exact_recall",
            "exact_f1",
            "false_positive_redaction_rate",
        ):
            values = [
                float(record[key]) for record in records if key in record
            ]
            if values:
                summary[key] = statistics.fmean(values)

    relaxed_records = [
        record
        for record in records
        if all(key in record for key in ("relaxed_tp", "relaxed_fp", "relaxed_fn"))
    ]
    if relaxed_records:
        tp = sum(int(record["relaxed_tp"]) for record in relaxed_records)
        fp = sum(int(record["relaxed_fp"]) for record in relaxed_records)
        fn = sum(int(record["relaxed_fn"]) for record in relaxed_records)
        precision, recall, f1 = _prf_counts(tp, fp, fn)
        summary.update(
            {
                "relaxed_tp": tp,
                "relaxed_fp": fp,
                "relaxed_fn": fn,
                "relaxed_precision": precision,
                "relaxed_recall": recall,
                "relaxed_f1": f1,
            }
        )

    character_records = [
        record
        for record in records
        if "gold_sensitive_characters" in record
        and "covered_sensitive_characters" in record
    ]
    if character_records:
        gold_characters = sum(
            int(record["gold_sensitive_characters"])
            for record in character_records
        )
        covered_characters = sum(
            int(record["covered_sensitive_characters"])
            for record in character_records
        )
        summary.update(
            {
                "gold_sensitive_characters": gold_characters,
                "covered_sensitive_characters": covered_characters,
                "character_recall": (
                    covered_characters / gold_characters
                    if gold_characters
                    else 1.0
                ),
            }
        )
    elif any("character_recall" in record for record in records):
        summary["character_recall"] = statistics.fmean(
            float(record["character_recall"])
            for record in records
            if "character_recall" in record
        )

    critical_records = [
        record
        for record in records
        if "critical_sensitive_characters" in record
        and "critical_surviving_characters" in record
    ]
    if critical_records:
        critical_characters = sum(
            int(record["critical_sensitive_characters"])
            for record in critical_records
        )
        surviving_critical = sum(
            int(record["critical_surviving_characters"])
            for record in critical_records
        )
        summary.update(
            {
                "critical_sensitive_characters": critical_characters,
                "critical_surviving_characters": surviving_critical,
                "critical_leak_rate": (
                    surviving_critical / critical_characters
                    if critical_characters
                    else 0.0
                ),
            }
        )
    elif any("critical_leak_rate" in record for record in records):
        summary["critical_leak_rate"] = statistics.fmean(
            float(record["critical_leak_rate"])
            for record in records
            if "critical_leak_rate" in record
        )
    return summary


def _prf_counts(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if tp + fp else (1.0 if not fn else 0.0)
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return precision, recall, f1


def _slice_summaries(
    trials: Sequence[TrialResult],
    field: str,
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, list[TrialResult]]] = {}
    for trial in trials:
        value = getattr(trial, field)
        if value is None:
            continue
        grouped.setdefault(str(value), {}).setdefault(trial.variant, []).append(trial)
    return {
        slice_value: {
            variant: _variant_summary(items)
            for variant, items in sorted(variants.items())
        }
        for slice_value, variants in sorted(grouped.items())
    }


def _resolve_expectations(
    trials: Sequence[TrialResult],
    *,
    expected_variants: Sequence[str] | None,
    expected_repeats: int | None,
) -> tuple[tuple[str, ...], int]:
    allowed_variants = {"baseline", "system", "oracle"}
    metadata_variants = {
        tuple(trial.expected_variants)
        for trial in trials
        if trial.expected_variants
    }
    if len(metadata_variants) > 1:
        raise ValueError("trials disagree about expected variants")
    if expected_variants is None:
        if metadata_variants:
            resolved_variants = next(iter(metadata_variants))
        else:
            resolved_variants = tuple(
                variant
                for variant in ("baseline", "system", "oracle")
                if any(trial.variant == variant for trial in trials)
            )
    else:
        resolved_variants = tuple(expected_variants)
        if metadata_variants and next(iter(metadata_variants)) != resolved_variants:
            raise ValueError("manifest and trials disagree about expected variants")
    if (
        not resolved_variants
        or len(set(resolved_variants)) != len(resolved_variants)
        or set(resolved_variants).difference(allowed_variants)
    ):
        raise ValueError("expected variants are invalid")

    metadata_repeats = {
        trial.expected_repeats
        for trial in trials
        if trial.expected_repeats is not None
    }
    if len(metadata_repeats) > 1:
        raise ValueError("trials disagree about expected repeat count")
    if expected_repeats is None:
        if metadata_repeats:
            resolved_repeats = next(iter(metadata_repeats))
        else:
            resolved_repeats = max((trial.repeat for trial in trials), default=0)
    else:
        resolved_repeats = expected_repeats
        if metadata_repeats and next(iter(metadata_repeats)) != resolved_repeats:
            raise ValueError("manifest and trials disagree about expected repeats")
    if (
        not isinstance(resolved_repeats, int)
        or isinstance(resolved_repeats, bool)
        or resolved_repeats < 1
    ):
        raise ValueError("expected repeats must be positive")
    return resolved_variants, resolved_repeats


def _validate_trial_keys(
    trials: Sequence[TrialResult],
    *,
    expected_variants: Sequence[str],
    expected_repeats: int,
    expected_case_ids: Sequence[str] | None,
) -> None:
    allowed_variants = {"baseline", "system", "oracle"}
    seen: set[tuple[str, int, str]] = set()
    configurations: dict[tuple[str, int], set[str]] = {}
    all_configurations: set[str] = set()
    expected_cases: set[str] | None = None
    if expected_case_ids is not None:
        if (
            not all(
                isinstance(case_id, str)
                and SAFE_METADATA_PATTERN.fullmatch(case_id) is not None
                for case_id in expected_case_ids
            )
            or len(set(expected_case_ids)) != len(expected_case_ids)
        ):
            raise ValueError("expected case ids are invalid")
        expected_cases = set(expected_case_ids)
    for trial in trials:
        if (
            not isinstance(trial.case_id, str)
            or SAFE_METADATA_PATTERN.fullmatch(trial.case_id) is None
            or trial.variant not in allowed_variants
            or trial.variant not in expected_variants
            or (
                expected_cases is not None
                and trial.case_id not in expected_cases
            )
            or not isinstance(trial.repeat, int)
            or isinstance(trial.repeat, bool)
            or trial.repeat < 1
            or trial.repeat > expected_repeats
        ):
            raise ValueError("trial has an invalid case, repeat, or variant key")
        for value in (trial.domain, trial.difficulty, trial.task_type, trial.split):
            if value is not None and (
                not isinstance(value, str)
                or SAFE_METADATA_PATTERN.fullmatch(value) is None
            ):
                raise ValueError("trial contains unsafe report metadata")
        if trial.failure is not None and not isinstance(trial.failure, str):
            raise ValueError("trial failure must be a string")
        key = (trial.case_id, trial.repeat, trial.variant)
        if key in seen:
            raise ValueError("duplicate trial key in comparator input")
        seen.add(key)
        if trial.failure is None:
            if (
                not isinstance(trial.configuration_hash, str)
                or not trial.configuration_hash.strip()
            ):
                raise ValueError(
                    "successful trials require a nonempty configuration hash"
                )
            score = trial.utility.get("score")
            if (
                isinstance(score, bool)
                or not isinstance(score, (int, float))
                or not math.isfinite(float(score))
                or not 0.0 <= float(score) <= 1.0
            ):
                raise ValueError(
                    "successful trials require a finite utility score from 0 to 1"
                )
            for value in trial.utility.values():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    if not math.isfinite(float(value)):
                        raise ValueError("utility metrics must be finite")
            configurations.setdefault(
                (trial.case_id, trial.repeat), set()
            ).add(trial.configuration_hash)
            all_configurations.add(trial.configuration_hash)
    if any(len(values) > 1 for values in configurations.values()):
        raise ValueError("paired trials used different Codex configurations")
    if len(all_configurations) > 1:
        raise ValueError("evaluation trials used different Codex configurations")


def _incomplete_trials(
    trials: Sequence[TrialResult],
    *,
    expected_variants: Sequence[str],
    expected_repeats: int,
    expected_case_ids: Sequence[str] | None,
) -> list[dict[str, Any]]:
    lookup = {
        (trial.case_id, trial.repeat, trial.variant): trial for trial in trials
    }
    incomplete: list[dict[str, Any]] = []
    case_ids = (
        set(expected_case_ids)
        if expected_case_ids is not None
        else {trial.case_id for trial in trials}
    )
    for case_id in sorted(case_ids):
        for repeat in range(1, expected_repeats + 1):
            for variant in expected_variants:
                trial = lookup.get((case_id, repeat, variant))
                if trial is None or trial.failure is not None:
                    incomplete.append(
                        {
                            "case_id": case_id,
                            "variant": variant,
                            "repeat": repeat,
                            "failure": _safe_failure_label(
                                trial.failure
                                if trial is not None and trial.failure is not None
                                else "missing_trial"
                            ),
                        }
                    )
    return incomplete


def _paired_trials(
    trials: Sequence[TrialResult],
    left_variant: str,
    right_variant: str,
) -> list[tuple[TrialResult, TrialResult]]:
    lookup = {
        (trial.case_id, trial.repeat, trial.variant): trial for trial in trials
    }
    pairs: list[tuple[TrialResult, TrialResult]] = []
    for case_id, repeat, variant in sorted(lookup):
        if variant != left_variant:
            continue
        left = lookup[(case_id, repeat, left_variant)]
        right = lookup.get((case_id, repeat, right_variant))
        if right is not None:
            pairs.append((left, right))
    return pairs


def _comparison(
    pairs: Sequence[tuple[TrialResult, TrialResult]],
    *,
    bootstrap_samples: int,
    seed: int,
) -> dict[str, Any]:
    deltas_by_case: dict[str, list[float]] = {}
    left_scores_by_case: dict[str, list[float]] = {}
    right_scores_by_case: dict[str, list[float]] = {}
    for left, right in pairs:
        left_score = float(left.utility.get("score", 0.0))
        right_score = float(right.utility.get("score", 0.0))
        deltas_by_case.setdefault(left.case_id, []).append(left_score - right_score)
        left_scores_by_case.setdefault(left.case_id, []).append(left_score)
        right_scores_by_case.setdefault(right.case_id, []).append(right_score)
    b = 0
    c = 0
    for case_id in sorted(deltas_by_case):
        left_pass = statistics.fmean(left_scores_by_case[case_id]) >= 0.999
        right_pass = statistics.fmean(right_scores_by_case[case_id]) >= 0.999
        if left_pass and not right_pass:
            b += 1
        elif right_pass and not left_pass:
            c += 1
    case_deltas = [
        statistics.fmean(values) for values in deltas_by_case.values() if values
    ]
    lower, upper = paired_bootstrap_ci(
        deltas_by_case, samples=bootstrap_samples, seed=seed
    )
    mcnemar = (
        max(abs(b - c) - 1, 0) ** 2 / (b + c)
        if b + c
        else 0.0
    )
    return {
        "complete_pair_count": len(pairs),
        "case_count": len(case_deltas),
        "utility_delta_mean": (
            statistics.fmean(case_deltas) if case_deltas else math.nan
        ),
        "utility_delta_ci95": [lower, upper],
        "mcnemar": {
            "unit": "case_mean_across_repeats",
            "left_only_pass": b,
            "right_only_pass": c,
            "discordant_case_count": b + c,
            "statistic": mcnemar,
        },
    }


def _write_csv(
    path: Path,
    trials: Sequence[TrialResult],
    case_metrics: Sequence[CaseMetrics],
) -> None:
    if case_metrics:
        rows = [_case_metrics_csv_row(item) for item in case_metrics]
        fixed_fields = [
            "case_id",
            "domain",
            "difficulty",
            "task_type",
            "split",
            "variant",
            "utility_score_mean",
            "completed_trials",
            "restoration_exact_rate_mean",
            "incomplete_pairs",
        ]
        extra_fields = sorted(
            {
                key
                for row in rows
                for key in row
                if key not in fixed_fields
            }
        )
        fieldnames = fixed_fields + extra_fields
    else:
        rows = [_trial_csv_row(trial) for trial in trials]
        fieldnames = list(rows[0]) if rows else [
            "case_id",
            "domain",
            "difficulty",
            "task_type",
            "split",
            "variant",
            "repeat",
            "utility_score",
            "privacy_exact_recall",
            "privacy_character_recall",
            "critical_leak_rate",
            "total_ms",
            "input_tokens",
            "output_tokens",
            "failed",
        ]
    descriptor, temporary = _new_private_temporary(path)
    try:
        handle = os.fdopen(
            descriptor,
            "w",
            encoding="utf-8",
            newline="",
        )
        descriptor = -1
        with handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(
                {
                    key: _csv_safe_cell(value)
                    for key, value in row.items()
                }
                for row in rows
            )
            handle.flush()
            os.fsync(handle.fileno())
        _replace_private_file(temporary, path)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def _case_metrics_csv_row(item: CaseMetrics) -> dict[str, Any]:
    row: dict[str, Any] = {
        "case_id": item.case_id,
        "domain": item.domain,
        "difficulty": item.difficulty,
        "task_type": item.task_type,
        "split": item.split,
        "variant": item.variant,
        "utility_score_mean": item.utility.get("score_mean", ""),
        "completed_trials": item.utility.get("completed_trials", ""),
        "restoration_exact_rate_mean": item.restoration.get(
            "exact_rate_mean", ""
        ),
        "incomplete_pairs": item.incomplete_pairs,
    }
    row.update({f"privacy_{key}": value for key, value in item.privacy.items()})
    row.update(
        {
            f"utility_{key}": value
            for key, value in item.utility.items()
            if key not in {"score_mean", "completed_trials"}
        }
    )
    row.update({f"latency_{key}": value for key, value in item.latency.items()})
    row.update(
        {
            f"tokens_{key}": value
            for key, value in item.token_metrics.items()
        }
    )
    return row


def _trial_csv_row(trial: TrialResult) -> dict[str, Any]:
    return {
        "case_id": trial.case_id,
        "domain": trial.domain or "",
        "difficulty": trial.difficulty or "",
        "task_type": trial.task_type or "",
        "split": trial.split or "",
        "variant": trial.variant,
        "repeat": trial.repeat,
        "utility_score": trial.utility.get("score", ""),
        "privacy_exact_recall": trial.privacy.get("exact_recall", ""),
        "privacy_character_recall": trial.privacy.get("character_recall", ""),
        "critical_leak_rate": trial.privacy.get("critical_leak_rate", ""),
        "total_ms": trial.timings.get("total_ms", ""),
        "input_tokens": trial.usage.get("input_tokens", ""),
        "output_tokens": trial.usage.get("output_tokens", ""),
        "failed": trial.failure is not None,
    }


def _render_html(summary: dict[str, Any]) -> str:
    comparison_rows = []
    for name, values in summary.get("comparisons", {}).items():
        interval = values.get("utility_delta_ci95", [math.nan, math.nan])
        comparison_rows.append(
            "<tr>"
            f"<td>{html.escape(name)}</td>"
            f"<td>{int(values.get('complete_pair_count', 0))}</td>"
            f"<td>{_format_number(values.get('utility_delta_mean'))}</td>"
            f"<td>[{_format_number(interval[0])}, {_format_number(interval[1])}]</td>"
            "</tr>"
        )
    utility_rows = []
    privacy_rows = []
    performance_rows = []
    for name, values in summary.get("variants", {}).items():
        escaped_name = html.escape(name)
        utility_payload = {
            "score_mean": values.get("utility_mean"),
            "score_median": values.get("utility_median"),
            **values.get("utility", {}),
        }
        utility_rows.append(
            "<tr>"
            f"<td>{escaped_name}</td>"
            f"<td>{int(values.get('count', 0))}</td>"
            f"<td>{html.escape(json.dumps(utility_payload, sort_keys=True))}</td>"
            "</tr>"
        )
        privacy_rows.append(
            "<tr>"
            f"<td>{escaped_name}</td>"
            f"<td>{html.escape(json.dumps(values.get('privacy', {}), sort_keys=True))}</td>"
            "</tr>"
        )
        performance_payload = {
            "latency_ms": values.get("latency_ms", {}),
            "usage": values.get("usage", {}),
        }
        performance_rows.append(
            "<tr>"
            f"<td>{escaped_name}</td>"
            f"<td>{html.escape(json.dumps(performance_payload, sort_keys=True))}</td>"
            "</tr>"
        )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>privacy-codex evaluation</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 2rem; color: #17202a; }}
table {{ border-collapse: collapse; width: 100%; margin-bottom: 2rem; }}
th, td {{ border: 1px solid #ccd1d1; padding: .55rem; text-align: left; }}
th {{ background: #f4f6f7; }}
.note {{ background: #eef6fc; padding: 1rem; border-left: 4px solid #2980b9; }}
</style>
</head>
<body>
<h1>privacy-codex evaluation</h1>
<p class="note">This report contains aggregate metrics only. Raw prompts, mappings, and
model outputs are intentionally excluded.</p>
<p>Completed trials: {int(summary.get("completed_trial_count", 0))};
incomplete trials: {int(summary.get("incomplete_trial_count", 0))}.</p>
<h2>Utility</h2>
<table><thead><tr><th>Variant</th><th>Trials</th><th>Metrics</th></tr></thead>
<tbody>{''.join(utility_rows)}</tbody></table>
<h2>Privacy</h2>
<table><thead><tr><th>Variant</th><th>Metrics</th></tr></thead>
<tbody>{''.join(privacy_rows)}</tbody></table>
<h2>Performance</h2>
<table><thead><tr><th>Variant</th><th>Latency and token usage</th></tr></thead>
<tbody>{''.join(performance_rows)}</tbody></table>
<h2>Paired comparisons</h2>
<table><thead><tr><th>Comparison</th><th>Pairs</th><th>Mean delta</th>
<th>Bootstrap 95% CI</th></tr></thead><tbody>{''.join(comparison_rows)}</tbody></table>
</body>
</html>
"""


def _secure_write(path: Path, text: str) -> None:
    payload = text.encode("utf-8")
    descriptor, temporary = _new_private_temporary(path)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("failed to write report")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        _replace_private_file(temporary, path)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def _prepare_report_directory(path: Path) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("report directory must not be a symbolic link")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("report path must be a regular directory")
    os.chmod(path, 0o700)


def _new_private_temporary(path: Path) -> tuple[int, Path]:
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise ValueError("report directory must be a regular directory")
    descriptor, name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    os.fchmod(descriptor, 0o600)
    return descriptor, Path(name)


def _replace_private_file(temporary: Path, path: Path) -> None:
    os.replace(temporary, path)
    os.chmod(path, 0o600)
    directory_descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def _format_number(value: Any) -> str:
    if not isinstance(value, (int, float)) or math.isnan(float(value)):
        return "n/a"
    return f"{float(value):.4f}"


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, dict):
        return {str(key): _json_safe(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(child) for child in value]
    return value


def _safe_failure_label(value: str) -> str:
    label = re.sub(r"[^a-z0-9_.-]+", "_", value.casefold()).strip("_")
    return (label or "unspecified_failure")[:80]


def _csv_safe_cell(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.lstrip()
    if stripped.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value
