from __future__ import annotations

import json
import tempfile
import unittest
from argparse import Namespace
from dataclasses import asdict
from pathlib import Path
from unittest.mock import Mock, patch

from privacy_codex.cli import (
    _handle_evaluate,
    _validate_frozen_baseline_dataset,
    build_parser,
)
from privacy_codex.comparator import (
    compare_trials,
    load_trials,
    safe_trial_dict,
    write_reports,
)
from privacy_codex.detectors import KnownValueDetector, RuleDetector
from privacy_codex.errors import EvaluationSafetyError
from privacy_codex.evaluator import (
    EvaluationConfig,
    Evaluator,
    compute_privacy_metrics,
    load_eval_cases,
    required_fact_metrics,
    score_utility,
)
from privacy_codex.models import AgentResult, CodexConfig, EvalCase, TrialResult
from privacy_codex.pipeline import (
    PipelineTrialExecutor,
    PrivacyPipeline,
    oracle_decisions,
)
from privacy_codex.policy import PolicyEngine
from privacy_codex.synthetic import generate_english_cases, validate_generated_cases


def make_case(*, synthetic: bool = True, task_type: str = "qa") -> EvalCase:
    document = "Guest name: Alice Morgan. Status: confirmed."
    start = document.index("Alice Morgan")
    expected = "confirmed" if task_type == "qa" else {"status": "confirmed"}
    return EvalCase(
        case_id="case-1",
        synthetic=synthetic,
        language="en",
        domain="travel-support",
        difficulty="easy",
        task_type=task_type,
        query="What is the status?",
        document=document,
        gold_spans=[
            {
                "source": "document",
                "start": start,
                "end": start + len("Alice Morgan"),
                "type": "PERSON",
                "action": "TOKENIZE",
                "coreference_group": "guest-1",
            }
        ],
        expected_answer=expected,
        required_facts=["confirmed"],
    )


class EvaluatorTests(unittest.TestCase):
    def test_privacy_exact_relaxed_and_character_metrics(self) -> None:
        gold = [
            {
                "source": "document",
                "start": 10,
                "end": 20,
                "type": "PERSON",
                "action": "TOKENIZE",
            }
        ]
        exact = compute_privacy_metrics(gold, gold)
        self.assertEqual(exact["exact_f1"], 1.0)
        self.assertTrue(exact["prompt_safe"])
        overlap = compute_privacy_metrics(
            gold,
            [
                {
                    "source": "document",
                    "start": 12,
                    "end": 20,
                    "type": "PERSON",
                    "action": "TOKENIZE",
                }
            ],
        )
        self.assertEqual(overlap["exact_f1"], 0.0)
        self.assertEqual(overlap["relaxed_f1"], 1.0)
        self.assertEqual(overlap["character_recall"], 0.8)

    def test_baseline_requires_explicit_flag_and_nonsynthetic_is_gated(self) -> None:
        def executor(case, variant, repeat, order):  # type: ignore[no-untyped-def]
            return TrialResult(
                case.case_id,
                variant,
                repeat,
                "confirmed",
                [],
                {},
                {},
                configuration_hash="same",
            )

        with self.assertRaises(EvaluationSafetyError):
            Evaluator(executor).run([make_case()])
        with self.assertRaises(EvaluationSafetyError):
            Evaluator(
                executor,
                EvaluationConfig(allow_unredacted_baseline=True),
            ).run([make_case(synthetic=False)])
        with self.assertRaises(EvaluationSafetyError):
            Evaluator(
                executor,
                EvaluationConfig(variants=("system",)),
            ).run([make_case(synthetic=False)])

    def test_dataset_requires_boolean_synthetic_and_safe_oracle_actions(self) -> None:
        malformed = asdict(make_case())
        malformed["synthetic"] = "false"
        with tempfile.TemporaryDirectory() as temporary:
            dataset = Path(temporary) / "malformed.jsonl"
            dataset.write_text(json.dumps(malformed) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_eval_cases(dataset)

        case = make_case()
        critical_start = case.document.index("confirmed")
        case.gold_spans.append(
            {
                "source": "document",
                "start": critical_start,
                "end": critical_start + len("confirmed"),
                "type": "CREDENTIAL",
                "action": "ALLOW",
            }
        )
        with self.assertRaises(EvaluationSafetyError):
            oracle_decisions(case)

    def test_case_schema_rejects_unsafe_metadata_actions_and_utility_gold(
        self,
    ) -> None:
        unsafe_metadata = asdict(make_case())
        unsafe_metadata["case_id"] = "=cmd|' /c calc'!a0"
        with self.assertRaises(ValueError):
            EvalCase.from_dict(unsafe_metadata)

        allowed_person = asdict(make_case())
        allowed_person["gold_spans"][0]["action"] = "ALLOW"
        with self.assertRaises(ValueError):
            EvalCase.from_dict(allowed_person)

        empty_answer = asdict(make_case())
        empty_answer["expected_answer"] = []
        with self.assertRaises(ValueError):
            EvalCase.from_dict(empty_answer)

        empty_extraction = asdict(make_case(task_type="extraction"))
        empty_extraction["expected_answer"] = {}
        with self.assertRaises(ValueError):
            EvalCase.from_dict(empty_extraction)

        empty_fact = asdict(make_case())
        empty_fact["required_facts"] = [""]
        with self.assertRaises(ValueError):
            EvalCase.from_dict(empty_fact)

    def test_required_facts_match_token_sequences_not_substrings(self) -> None:
        metrics = required_fact_metrics(["in"], "confirmed")
        self.assertEqual(metrics["required_fact_recall"], 0.0)
        metrics = required_fact_metrics(["pending review"], "Status: pending review.")
        self.assertEqual(metrics["required_fact_recall"], 1.0)

    def test_three_arm_repeats_randomized_and_scored_against_gold(self) -> None:
        observed_orders = []

        def executor(case, variant, repeat, order):  # type: ignore[no-untyped-def]
            observed_orders.append((order, variant, repeat))
            return TrialResult(
                case.case_id,
                variant,
                repeat,
                "confirmed",
                [{"type": "not-stored-in-report", "raw": "SENTINEL_SECRET"}],
                {"input_tokens": 10},
                {"total_ms": 5.0},
                privacy={"exact_recall": 1.0},
                configuration_hash="same",
            )

        trials, cases = Evaluator(
            executor,
            EvaluationConfig(repeats=3, allow_unredacted_baseline=True, seed=7),
        ).run([make_case()])
        self.assertEqual(len(trials), 9)
        self.assertEqual(len(cases), 3)
        self.assertEqual(
            {metrics.variant for metrics in cases},
            {"baseline", "system", "oracle"},
        )
        self.assertTrue(all(metrics.split == "test" for metrics in cases))
        self.assertEqual({trial.variant for trial in trials}, {"baseline", "system", "oracle"})
        self.assertTrue(all(trial.utility["score"] == 1.0 for trial in trials))
        self.assertEqual(cases[0].incomplete_pairs, 0)
        self.assertNotEqual(
            [variant for _, variant, _ in observed_orders],
            ["baseline", "system", "oracle"] * 3,
        )
        with tempfile.TemporaryDirectory() as temporary:
            csv_path = write_reports(
                Path(temporary),
                compare_trials(trials, bootstrap_samples=10),
                trials,
                cases,
                formats=("csv",),
            )["csv"]
            csv_lines = csv_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(csv_lines), 4)
            self.assertIn("utility_score_mean", csv_lines[0])
            self.assertIn(
                "utility_relationship_preservation_mean",
                csv_lines[0],
            )
            self.assertNotIn(",repeat,", csv_lines[0])

    def test_qa_and_structured_extraction_metrics(self) -> None:
        qa = score_utility(make_case(), "Confirmed")
        self.assertEqual(qa["score"], 1.0)
        self.assertEqual(qa["relationship_preservation"], 1.0)
        extraction = score_utility(
            make_case(task_type="extraction"),
            '```json\n{"status":"confirmed"}\n```',
        )
        self.assertEqual(extraction["field_exact_match"], 1.0)
        self.assertEqual(extraction["score"], 1.0)
        self.assertEqual(extraction["relationship_preservation"], 1.0)
        type_mismatch = score_utility(
            EvalCase(
                case_id="typed-extraction",
                synthetic=True,
                language="en",
                domain="travel-support",
                difficulty="easy",
                task_type="extraction",
                query="Extract the count.",
                document="count: 1",
                gold_spans=[],
                expected_answer={"count": 1},
                required_facts=[],
            ),
            '{"count":"1"}',
        )
        self.assertFalse(type_mismatch["schema_valid"])
        self.assertEqual(type_mismatch["matched_fields"], 0)

    def test_pipeline_trial_executor_runs_three_variants_with_safe_artifacts(self) -> None:
        class StaticRunner:
            config = CodexConfig()

            def run(self, prompt):  # type: ignore[no-untyped-def]
                return AgentResult(
                    output="confirmed",
                    events=[{"type": "future.event", "value": "confirmed"}],
                    unknown_events=[{"type": "future.event", "value": "confirmed"}],
                    usage={"input_tokens": 8, "output_tokens": 1},
                    timings={"codex_seconds": 0.001},
                    exit_code=0,
                )

        pipeline = PrivacyPipeline(
            detectors=[KnownValueDetector(), RuleDetector()],
            policy=PolicyEngine(),
            runner=StaticRunner(),  # type: ignore[arg-type]
        )
        with tempfile.TemporaryDirectory() as temporary:
            executor = PipelineTrialExecutor(
                pipeline,
                runs_dir=Path(temporary) / "trials",
            )
            trials, _ = Evaluator(
                executor,
                EvaluationConfig(
                    repeats=1,
                    allow_unredacted_baseline=True,
                    seed=2,
                ),
            ).run([make_case()])
            self.assertEqual(len(trials), 3)
            self.assertTrue(all(trial.failure is None for trial in trials))
            self.assertEqual(len(executor.run_paths), 3)
            observed_stages: set[str] = set()
            for root in executor.run_paths:
                observed_stages.update(
                    json.loads(line)["stage"]
                    for line in (root / "stages.jsonl")
                    .read_text(encoding="utf-8")
                    .splitlines()
                )
                stored_metrics = json.loads(
                    (root / "metrics.json").read_text(encoding="utf-8")
                )
                manifest = json.loads(
                    (root / "manifest.json").read_text(encoding="utf-8")
                )
                self.assertEqual(stored_metrics["utility"]["score"], 1.0)
                self.assertEqual(manifest["dataset_split"], "test")
                self.assertEqual(manifest["case_split"], "test")
                self.assertIn("policy_sha256", manifest["versions"])
                self.assertTrue(manifest["detectors"])
            self.assertIn("baseline_passthrough", observed_stages)
            self.assertIn("codex", observed_stages)
            self.assertIn("output_scan_and_restoration", observed_stages)
            self.assertIn("baseline_output_capture", observed_stages)
            combined = b"".join(
                path.read_bytes()
                for root in executor.run_paths
                for path in root.rglob("*")
                if path.is_file()
            )
            self.assertNotIn(b"Alice Morgan", combined)


class ComparatorAndDatasetTests(unittest.TestCase):
    def test_sensitive_logging_preflight_precedes_dataset_read(self) -> None:
        arguments = Namespace(policy=None, allow_sensitive_logs=True)
        with (
            patch("privacy_codex.cli._effective_config", return_value=Mock()),
            patch("privacy_codex.cli._build_pipeline", return_value=Mock()),
            patch(
                "privacy_codex.cli.validate_sensitive_artifact_configuration",
                side_effect=ValueError("encryption unavailable"),
            ),
            patch("privacy_codex.cli.load_eval_cases") as load_cases,
        ):
            with self.assertRaises(ValueError):
                _handle_evaluate(arguments)
        load_cases.assert_not_called()

    def test_missing_arms_are_reported_and_single_arm_is_complete(self) -> None:
        system = TrialResult(
            "case-1",
            "system",
            1,
            "",
            [],
            {},
            {},
            utility={"score": 1.0},
            configuration_hash="same",
            expected_variants=("baseline", "system"),
            expected_repeats=1,
        )
        summary = compare_trials([system], bootstrap_samples=10)
        self.assertEqual(summary["incomplete_trial_count"], 1)
        self.assertEqual(
            summary["incomplete_trials"][0]["variant"],
            "baseline",
        )

        system.expected_variants = ("system",)
        summary = compare_trials([system], bootstrap_samples=10)
        self.assertEqual(summary["incomplete_trial_count"], 0)

    def test_successful_trials_require_finite_utility_and_configuration(self) -> None:
        trial = TrialResult(
            "case-1",
            "system",
            1,
            "",
            [],
            {},
            {},
            utility={"score": 1.0},
        )
        with self.assertRaises(ValueError):
            compare_trials([trial], bootstrap_samples=10)
        trial.configuration_hash = "same"
        trial.utility["score"] = float("nan")
        with self.assertRaises(ValueError):
            compare_trials([trial], bootstrap_samples=10)

    def test_mcnemar_uses_case_as_the_repeat_cluster(self) -> None:
        trials = [
            TrialResult(
                "case-1",
                variant,
                repeat,
                "",
                [],
                {},
                {},
                utility={"score": score},
                configuration_hash="same",
            )
            for repeat, values in (
                (1, {"system": 1.0, "baseline": 0.0}),
                (2, {"system": 0.0, "baseline": 1.0}),
            )
            for variant, score in values.items()
        ]
        mcnemar = compare_trials(trials, bootstrap_samples=10)["comparisons"][
            "system_vs_baseline"
        ]["mcnemar"]
        self.assertEqual(mcnemar["unit"], "case_mean_across_repeats")
        self.assertEqual(mcnemar["discordant_case_count"], 0)

    def test_csv_formula_cells_are_neutralized(self) -> None:
        trial = TrialResult(
            "=1+1",
            "system",
            1,
            "",
            [],
            {},
            {},
            utility={"score": 1.0},
            configuration_hash="same",
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = write_reports(
                Path(temporary),
                {
                    "completed_trial_count": 1,
                    "incomplete_trial_count": 0,
                    "variants": {},
                    "comparisons": {},
                },
                [trial],
                formats=("csv",),
            )["csv"]
            self.assertIn("'=1+1", path.read_text(encoding="utf-8"))

    def test_report_writer_refuses_symlinked_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir()
            report = root / "report"
            report.symlink_to(target, target_is_directory=True)
            with self.assertRaises(ValueError):
                write_reports(
                    report,
                    {
                        "completed_trial_count": 0,
                        "incomplete_trial_count": 0,
                        "variants": {},
                        "comparisons": {},
                    },
                    [],
                )
            self.assertEqual(list(target.iterdir()), [])

    def test_frozen_corpus_gate_split_default_and_bounded_jsonl(self) -> None:
        parser = build_parser()
        parsed = parser.parse_args(
            ["evaluate", "--dataset", "evals/english_synthetic.jsonl"]
        )
        self.assertEqual(parsed.split, "test")
        frozen = Path(__file__).resolve().parents[1] / "evals" / "english_synthetic.jsonl"
        _validate_frozen_baseline_dataset(frozen)
        with tempfile.TemporaryDirectory() as temporary:
            modified = Path(temporary) / "modified.jsonl"
            modified.write_bytes(frozen.read_bytes() + b"\n")
            with self.assertRaises(ValueError):
                _validate_frozen_baseline_dataset(modified)

            oversized = Path(temporary) / "oversized.jsonl"
            oversized.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
            with self.assertRaises(ValueError):
                load_eval_cases(oversized)
            with self.assertRaises(ValueError):
                load_trials(oversized)

    def test_reports_exclude_raw_outputs_and_events(self) -> None:
        trials = []
        for repeat in (1, 2, 3):
            for variant, score in (("baseline", 1.0), ("system", 0.98), ("oracle", 0.99)):
                trials.append(
                    TrialResult(
                        "case-1",
                        variant,
                        repeat,
                        "SENTINEL_SECRET",
                        [{"type": "event", "payload": "SENTINEL_SECRET"}],
                        {"input_tokens": 10, "output_tokens": 2},
                        {"total_ms": 4.0},
                        privacy={"exact_recall": 1.0},
                        utility={"score": score},
                        configuration_hash="same",
                    )
                )
        summary = compare_trials(trials, bootstrap_samples=100)
        self.assertAlmostEqual(
            summary["variants"]["system"]["utility"]["score_mean"],
            0.98,
        )
        self.assertEqual(
            summary["comparisons"]["system_vs_baseline"]["complete_pair_count"], 3
        )
        self.assertAlmostEqual(
            summary["comparisons"]["system_vs_baseline"]["utility_delta_mean"],
            -0.02,
        )
        self.assertNotIn("output", safe_trial_dict(trials[0]))
        self.assertNotIn("codex_events", safe_trial_dict(trials[0]))
        self.assertNotIn("output", trials[0].safe_dict())
        self.assertNotIn("codex_events", trials[0].safe_dict())
        with tempfile.TemporaryDirectory() as temporary:
            paths = write_reports(Path(temporary), summary, trials)
            combined = "".join(path.read_text(encoding="utf-8") for path in paths.values())
            self.assertNotIn("SENTINEL_SECRET", combined)
            html_report = paths["html"].read_text(encoding="utf-8")
            self.assertIn("<h2>Utility</h2>", html_report)
            self.assertIn("<h2>Privacy</h2>", html_report)
            self.assertIn("<h2>Performance</h2>", html_report)

    def test_privacy_aggregates_are_micro_averaged_and_duplicate_keys_rejected(
        self,
    ) -> None:
        trials = []
        for index in range(50):
            missed = index == 49
            privacy = {
                "exact_tp": 0,
                "exact_fp": 0,
                "exact_fn": int(missed),
                "gold_sensitive_characters": 10 if missed else 0,
                "covered_sensitive_characters": 0,
                "critical_sensitive_characters": 0,
                "critical_surviving_characters": 0,
                "prompt_safe": not missed,
                "per_entity": {},
            }
            if index == 0:
                privacy["per_entity"] = {
                    "EMAIL": {
                        "exact_tp": 0,
                        "exact_fp": 1,
                        "exact_fn": 0,
                        "gold_sensitive_characters": 0,
                        "covered_sensitive_characters": 0,
                        "critical_sensitive_characters": 0,
                        "critical_surviving_characters": 0,
                    }
                }
            trials.append(
                TrialResult(
                    f"case-{index}",
                    "system",
                    1,
                    "",
                    [],
                    {},
                    {},
                    privacy=privacy,
                    utility={"score": 1.0},
                    configuration_hash="same",
                )
            )
        summary = compare_trials(trials, bootstrap_samples=10)
        self.assertEqual(
            summary["variants"]["system"]["privacy"]["exact_recall"],
            0.0,
        )
        self.assertEqual(
            summary["variants"]["system"]["privacy"]["character_recall"],
            0.0,
        )
        self.assertEqual(
            summary["variants"]["system"]["privacy"]["per_entity"]["EMAIL"][
                "exact_precision"
            ],
            0.0,
        )
        with self.assertRaises(ValueError):
            compare_trials([trials[0], trials[0]], bootstrap_samples=10)

    def test_generated_dataset_has_50_valid_english_cases_and_frozen_split(self) -> None:
        cases = generate_english_cases()
        validate_generated_cases(cases)
        self.assertEqual(len(cases), 50)
        self.assertEqual(sum(case["task_type"] == "extraction" for case in cases), 25)
        self.assertEqual(sum(case["task_type"] == "qa" for case in cases), 25)
        self.assertEqual(sum(case["split"] == "dev" for case in cases), 10)
        self.assertEqual(sum(case["split"] == "test" for case in cases), 40)
        extraction_bookings = {
            case["expected_answer"]["booking"]
            for case in cases
            if case["task_type"] == "extraction"
        }
        qa_booking_values = {
            case[span["source"]][span["start"] : span["end"]]
            for case in cases
            for span in case["gold_spans"]
            if case["task_type"] == "qa" and span["type"] == "BOOKING_ID"
        }
        self.assertTrue(
            all(value.startswith("DTR") for value in extraction_bookings)
        )
        self.assertTrue(all(value.startswith("DTQ") for value in qa_booking_values))
        entity_types = {
            span["type"] for case in cases for span in case["gold_spans"]
        }
        self.assertTrue(
            {
                "PERSON",
                "EMAIL",
                "PHONE",
                "PRIVATE_ADDRESS",
                "DATE",
                "BOOKING_ID",
                "LOYALTY_ID",
                "ACCOUNT_ID",
                "PASSPORT_ID",
                "PAYMENT_CARD",
                "CVV",
                "CREDENTIAL",
                "PRIVATE_KEY",
            }.issubset(entity_types)
        )

    def test_checked_in_dataset_loads(self) -> None:
        dataset = (
            Path(__file__).resolve().parents[1]
            / "evals"
            / "english_synthetic.jsonl"
        )
        cases = load_eval_cases(dataset)
        self.assertEqual(len(cases), 50)


if __name__ == "__main__":
    unittest.main()
