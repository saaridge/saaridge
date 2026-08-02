#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from privacy_codex.detectors import (
    KnownValueDetector,
    PrivacyFilterDetector,
    RuleDetector,
)
from privacy_codex.edge_detector import EdgeMLDetector
from privacy_codex.evaluator import compute_privacy_metrics, load_eval_cases
from privacy_codex.models import LoadedInput, TextSource
from privacy_codex.pipeline import PrivacyPipeline
from privacy_codex.policy import PolicyEngine


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("evals/english_synthetic.jsonl"),
    )
    parser.add_argument("--warm-repeats", type=int, default=30)
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--model-digest")
    parser.add_argument("--edge-model", type=Path)
    parser.add_argument("--edge-model-digest")
    parser.add_argument("--classifier-timeout", type=float, default=120.0)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if (arguments.model_path is None) != (arguments.model_digest is None):
        parser.error("--model-path and --model-digest must be supplied together")
    if (arguments.edge_model is None) != (arguments.edge_model_digest is None):
        parser.error("--edge-model and --edge-model-digest must be supplied together")

    cases = load_eval_cases(arguments.dataset)
    detectors = [KnownValueDetector(), RuleDetector()]
    scope = "deterministic-rules-only"
    if arguments.model_path is not None:
        detectors.append(
            PrivacyFilterDetector(
                arguments.model_path.resolve(),
                required=True,
                expected_digest=arguments.model_digest,
            )
        )
        scope = "deterministic-plus-local-classifier"
    if arguments.edge_model is not None:
        detectors.append(
            EdgeMLDetector(
                arguments.edge_model.resolve(),
                required=True,
                expected_digest=arguments.edge_model_digest,
            )
        )
        scope = (
            "deterministic-plus-edge-ml"
            if arguments.model_path is None
            else "deterministic-plus-edge-ml-plus-local-classifier"
        )
    pipeline = PrivacyPipeline(
        detectors=detectors,
        policy=PolicyEngine(),
        runner=None,
        detector_timeout_seconds=arguments.classifier_timeout,
    )
    pipeline.preflight_detectors()
    case_metrics: list[dict[str, Any]] = []
    entity_counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    false_positives = 0
    for case in cases:
        result = pipeline.redact(
            LoadedInput(
                TextSource("query", case.query),
                TextSource("document", case.document),
            ),
            evaluation_mode=True,
        )
        metrics = compute_privacy_metrics(case.gold_spans, result.result.decisions)
        case_metrics.append(metrics)
        predicted = {
            (
                decision.span.source,
                decision.span.start,
                decision.span.end,
                decision.span.entity_type,
            )
            for decision in result.result.decisions
        }
        gold = {
            (span["source"], span["start"], span["end"], span["type"])
            for span in case.gold_spans
        }
        false_positives += len(predicted.difference(gold))
        for span in gold:
            entity_counts[span[3]][1] += 1
            entity_counts[span[3]][0] += int(span in predicted)

    warm_input = LoadedInput(
        TextSource("query", " ".join(["ordinary"] * 2_000)),
        None,
    )
    pipeline.redact(warm_input)
    latency_ms: list[float] = []
    for _ in range(arguments.warm_repeats):
        started = time.perf_counter()
        pipeline.redact(warm_input)
        latency_ms.append((time.perf_counter() - started) * 1_000)

    exact_tp = sum(int(item["exact_tp"]) for item in case_metrics)
    exact_fp = sum(int(item["exact_fp"]) for item in case_metrics)
    exact_fn = sum(int(item["exact_fn"]) for item in case_metrics)
    exact_precision, exact_recall, exact_f1 = _prf(
        exact_tp, exact_fp, exact_fn
    )
    report = {
        "scope": scope,
        "warning": (
            "Codex utility trials are excluded."
            if arguments.model_path is not None
            else (
                "This is not the release benchmark. The required local privacy "
                "classifier and Codex utility trials are intentionally excluded."
            )
        ),
        "case_count": len(cases),
        "privacy": {
            "exact_tp": exact_tp,
            "exact_fp": exact_fp,
            "exact_fn": exact_fn,
            "exact_precision": exact_precision,
            "exact_recall": exact_recall,
            "exact_f1": exact_f1,
            "character_recall": (
                sum(
                    int(item["covered_sensitive_characters"])
                    for item in case_metrics
                )
                / sum(
                    int(item["gold_sensitive_characters"])
                    for item in case_metrics
                )
            ),
        },
        "prompt_safe_rate": statistics.fmean(
            float(item["prompt_safe"]) for item in case_metrics
        ),
        "false_positive_count": false_positives,
        "per_entity_recall": {
            entity: {
                "detected": counts[0],
                "gold": counts[1],
                "recall": counts[0] / counts[1],
            }
            for entity, counts in sorted(entity_counts.items())
        },
        "warm_2000_token_latency_ms": {
            "repeats": len(latency_ms),
            "p50": _percentile(latency_ms, 50),
            "p95": _percentile(latency_ms, 95),
            "p99": _percentile(latency_ms, 99),
        },
    }
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


def _percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if tp + fp else (1.0 if not fn else 0.0)
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return precision, recall, f1


if __name__ == "__main__":
    raise SystemExit(main())
