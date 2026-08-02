from __future__ import annotations

import os
import signal
import tempfile
import time
import unittest
from pathlib import Path

from privacy_codex.detectors import (
    DetectorOrchestrator,
    KnownValueDetector,
    PrivacyFilterDetector,
    RuleDetector,
    luhn_valid,
)
from privacy_codex.errors import DetectorExecutionError, DetectorUnavailableError
from privacy_codex.models import (
    Action,
    DetectionContext,
    Severity,
    Span,
    TextSource,
)
from privacy_codex.policy import PolicyEngine, fuse_spans


class RuleDetectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.detector = RuleDetector()

    def detect(self, text: str):
        return self.detector.detect(text, DetectionContext(source="document"))

    def test_exact_offsets_for_english_contextual_and_structured_entities(self) -> None:
        text = (
            "Guest name: Alice Morgan\n"
            "Email: alice.morgan@example.test\n"
            "Mobile: +65 8123 4567\n"
            "Home address: 123 Orchard Road, Singapore\n"
            "Date of birth: 1988-04-17\n"
            "Booking ID: TRV123456\n"
            "Loyalty number: LOY998877\n"
            "Account ID: ACC445566\n"
            "Passport number: P1234567\n"
            "Source 10.20.30.40\n"
        )
        spans = self.detect(text)
        expected = {
            "PERSON": "Alice Morgan",
            "EMAIL": "alice.morgan@example.test",
            "PHONE": "+65 8123 4567",
            "PRIVATE_ADDRESS": "123 Orchard Road, Singapore",
            "DATE": "1988-04-17",
            "BOOKING_ID": "TRV123456",
            "LOYALTY_ID": "LOY998877",
            "ACCOUNT_ID": "ACC445566",
            "PASSPORT_ID": "P1234567",
            "IP_ADDRESS": "10.20.30.40",
        }
        observed = {
            span.entity_type: text[span.start : span.end]
            for span in spans
            if span.entity_type in expected
        }
        self.assertEqual(observed, expected)
        for span in spans:
            expected_value = observed.get(
                span.entity_type, text[span.start : span.end]
            )
            self.assertEqual(text[span.start : span.end], expected_value)

    def test_unicode_punctuation_and_whitespace_preserve_offsets(self) -> None:
        text = (
            "Customer name — Élodie Martin\n"
            "Phone:\u202f+33\u202f6\u202f12\u202f34\u202f56\u202f78"
        )
        spans = self.detect(text)
        person = next(span for span in spans if span.entity_type == "PERSON")
        phone = next(span for span in spans if span.entity_type == "PHONE")
        self.assertEqual(text[person.start : person.end], "Élodie Martin")
        self.assertEqual(
            text[phone.start : phone.end],
            "+33\u202f6\u202f12\u202f34\u202f56\u202f78",
        )

    def test_short_uncontextual_numeric_lookalikes_are_not_phones(self) -> None:
        lookalikes = (
            "Build 123-4567; version 1.2.3.4567; reference 12 34 567."
        )
        self.assertFalse(
            any(span.entity_type == "PHONE" for span in self.detect(lookalikes))
        )

        contextual = "Phone: 123-4567"
        phone = next(
            span
            for span in self.detect(contextual)
            if span.entity_type == "PHONE"
        )
        self.assertEqual(contextual[phone.start : phone.end], "123-4567")

    def test_cards_credentials_cvv_and_private_key_are_critical(self) -> None:
        text = (
            "Card 4111 1111 1111 1111; CVV: 737; "
            "api_key=synthetic-ABCDEFGHIJKL; password=OnlyForTest123\n"
            "-----BEGIN PRIVATE KEY-----\n"
            "c3ludGhldGljLWtleS10ZXN0LW9ubHk=\n"
            "-----END PRIVATE KEY-----"
        )
        spans = self.detect(text)
        types = {span.entity_type for span in spans}
        self.assertTrue(
            {"PAYMENT_CARD", "CVV", "CREDENTIAL", "PRIVATE_KEY"}.issubset(types)
        )
        self.assertTrue(
            all(
                span.severity is Severity.CRITICAL
                for span in spans
                if span.entity_type
                in {"PAYMENT_CARD", "CVV", "CREDENTIAL", "PRIVATE_KEY"}
            )
        )
        self.assertTrue(luhn_valid("4111111111111111"))
        self.assertFalse(luhn_valid("4111111111111112"))

    def test_common_cloud_database_and_password_credentials_are_critical(self) -> None:
        credentials = [
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
            "ASIAABCDEFGHIJKLMNOP",
            "postgresql://demo:OnlyForTest123@db.example.test/app",
            'DB_PASSWORD="correct horse battery staple"',
            "--password='synthetic cli password'",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n"
            "c3ludGhldGljLWtleS10ZXN0LW9ubHk=\n"
            "-----END ENCRYPTED PRIVATE KEY-----",
        ]
        text = "\n".join(credentials)
        spans = self.detect(text)
        observed = [text[span.start : span.end] for span in spans]
        for credential in credentials:
            self.assertTrue(
                any(
                    credential in value or value in credential
                    for value in observed
                ),
                credential,
            )
        self.assertTrue(
            all(
                span.severity is Severity.CRITICAL
                for span in spans
                if span.entity_type in {"CREDENTIAL", "PRIVATE_KEY"}
            )
        )

    def test_unicode_spaced_luhn_card_is_blocked_with_exact_offsets(self) -> None:
        card = "4111\u202f1111\u202f1111\u202f1111"
        text = f"Payment card: {card}."
        span = next(
            item
            for item in self.detect(text)
            if item.entity_type == "PAYMENT_CARD"
        )
        self.assertEqual(text[span.start : span.end], card)
        self.assertIs(PolicyEngine().resolve([span])[0].action, Action.BLOCK)

    def test_separator_obfuscated_luhn_cards_are_blocked(self) -> None:
        detector = RuleDetector()
        for separator in (".", "/", "_", " - "):
            card = separator.join(("4111", "1111", "1111", "1111"))
            text = f"Payment card: {card}."
            with self.subTest(separator=separator):
                spans = detector.detect(text, DetectionContext("query"))
                cards = [
                    item
                    for item in spans
                    if item.entity_type == "PAYMENT_CARD"
                ]
                self.assertEqual(len(cards), 1)
                self.assertEqual(text[cards[0].start : cards[0].end], card)
                self.assertIs(
                    PolicyEngine().resolve(cards)[0].action,
                    Action.BLOCK,
                )

    def test_jwt_and_invalid_ip(self) -> None:
        text = (
            "token=eyJhbGciOiJIUzI1NiJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c "
            "invalid=999.10.10.10"
        )
        spans = self.detect(text)
        self.assertIn("CREDENTIAL", {span.entity_type for span in spans})
        self.assertNotIn(
            "999.10.10.10",
            [text[span.start : span.end] for span in spans],
        )

    def test_public_names_dates_and_numeric_lookalikes_are_not_redacted(self) -> None:
        text = (
            "Jordan Suites in Victoria opened on 2024-01-01. "
            "HTTP 200, hotel code H10001, and room 411 are public."
        )
        spans = self.detect(text)
        self.assertFalse(
            any(
                span.entity_type
                in {"PERSON", "DATE", "BOOKING_ID", "ACCOUNT_ID", "PAYMENT_CARD"}
                for span in spans
            )
        )

    def test_email_before_sentence_punctuation_is_detected_exactly(self) -> None:
        text = "Contact alice@example.test. Then continue."
        spans = self.detect(text)
        email = next(span for span in spans if span.entity_type == "EMAIL")
        self.assertEqual(text[email.start : email.end], "alice@example.test")

    def test_contextual_person_stops_before_status_and_higher_confidence_model_wins(
        self,
    ) -> None:
        text = "Guest: Alice Morgan checked out yesterday"
        rule = next(
            span for span in self.detect(text) if span.entity_type == "PERSON"
        )
        self.assertEqual(text[rule.start : rule.end], "Alice Morgan")
        self.assertFalse(rule.validated)
        model = Span(
            "document",
            rule.start,
            rule.end,
            "PERSON",
            0.99,
            "privacy_filter",
            Severity.HIGH,
            False,
        )
        fused = fuse_spans([rule, model])
        self.assertEqual(fused[0].detector, "privacy_filter")


class KnownAndClassifierTests(unittest.TestCase):
    def test_known_value_repeats_and_identifier_boundaries(self) -> None:
        text = "Alice Morgan met Alice Morgan. XTRV123456Y differs from TRV123456."
        detector = KnownValueDetector()
        spans = detector.detect(
            text,
            DetectionContext(
                source="document",
                known_values={
                    "PERSON": ["Alice Morgan"],
                    "BOOKING_ID": ["TRV123456"],
                },
            ),
        )
        people = [span for span in spans if span.entity_type == "PERSON"]
        bookings = [span for span in spans if span.entity_type == "BOOKING_ID"]
        self.assertEqual(len(people), 2)
        self.assertEqual(len(bookings), 1)
        self.assertEqual(text[bookings[0].start : bookings[0].end], "TRV123456")

    def test_injected_privacy_classifier_and_private_date(self) -> None:
        text = "Name is lower-case person and public date."
        detector = PrivacyFilterDetector(
            required=True,
            inference=lambda _: [
                {
                    "start": 8,
                    "end": 25,
                    "entity_group": "private_person",
                    "score": 0.98,
                },
                {
                    "start": 30,
                    "end": 34,
                    "entity_group": "date",
                    "score": 0.99,
                    "private": False,
                },
            ],
        )
        spans = detector.detect(text, DetectionContext(source="document"))
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].entity_type, "PERSON")
        self.assertEqual(text[spans[0].start : spans[0].end], "lower-case person")

    def test_policy_is_the_only_classifier_confidence_gate(self) -> None:
        text = "Guest is Alice Person."
        detector = PrivacyFilterDetector(
            required=True,
            inference=lambda _: [
                {
                    "start": 9,
                    "end": 21,
                    "entity_group": "PERSON",
                    "score": 0.60,
                }
            ],
        )
        spans = detector.detect(text, DetectionContext(source="document"))
        self.assertEqual(len(spans), 1)
        self.assertEqual(PolicyEngine().resolve(spans), [])
        decisions = PolicyEngine(
            thresholds={"PERSON": 0.50},
        ).resolve(spans)
        self.assertEqual(len(decisions), 1)
        self.assertIs(decisions[0].action, Action.TOKENIZE)

    def test_required_classifier_failure_is_fail_closed(self) -> None:
        orchestrator = DetectorOrchestrator(
            [PrivacyFilterDetector(required=True)],
            timeout_seconds=1,
        )
        with self.assertRaises(DetectorUnavailableError):
            orchestrator.detect_sources([TextSource("query", "hello")])

    def test_required_local_classifier_requires_digest_pin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            detector = PrivacyFilterDetector(
                Path(temporary).resolve(),
                required=True,
            )
            with self.assertRaises(DetectorUnavailableError):
                detector.detect("hello", DetectionContext(source="document"))

    def test_classifier_windows_preserve_tail_offsets(self) -> None:
        tail_value = "Tail Person"
        text = ("ordinary " * 260) + tail_value

        def infer(window: str):  # type: ignore[no-untyped-def]
            if tail_value not in window:
                return []
            start = window.index(tail_value)
            return [
                {
                    "start": start,
                    "end": start + len(tail_value),
                    "entity_group": "PERSON",
                    "score": 0.99,
                }
            ]

        detector = PrivacyFilterDetector(required=True, inference=infer)
        spans = detector.detect(text, DetectionContext(source="document"))
        tail = next(span for span in spans if span.entity_type == "PERSON")
        self.assertGreater(tail.start, 1_600)
        self.assertEqual(text[tail.start : tail.end], tail_value)

    def test_optional_classifier_failure_does_not_hide_rule_results(self) -> None:
        orchestrator = DetectorOrchestrator(
            [RuleDetector(), PrivacyFilterDetector(required=False)],
            timeout_seconds=1,
        )
        spans, _ = orchestrator.detect_sources(
            [TextSource("query", "Email guest@example.test")]
        )
        self.assertIn("EMAIL", {span.entity_type for span in spans})

    @unittest.skipUnless(os.name == "posix", "classifier worker requires POSIX")
    def test_classifier_timeout_kills_worker_and_restarts_lazily(self) -> None:
        def infer(window: str):  # type: ignore[no-untyped-def]
            if window == "hang":
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                time.sleep(60)
                return []
            if "Alice Person" not in window:
                return []
            start = window.index("Alice Person")
            return [
                {
                    "start": start,
                    "end": start + len("Alice Person"),
                    "entity_group": "PERSON",
                    "score": 0.99,
                }
            ]

        detector = PrivacyFilterDetector(required=True, inference=infer)
        orchestrator = DetectorOrchestrator(
            [detector],
            timeout_seconds=0.2,
        )
        restarted_pid: int | None = None
        try:
            started = time.monotonic()
            with self.assertRaises(DetectorExecutionError):
                orchestrator.detect_sources([TextSource("query", "hang")])
            self.assertLess(time.monotonic() - started, 1.0)

            timed_out_pid = orchestrator.last_worker_pid(detector)
            self.assertIsNotNone(timed_out_pid)
            self.assertIsNone(orchestrator.active_worker_pid(detector))
            assert timed_out_pid is not None
            with self.assertRaises(ProcessLookupError):
                os.kill(timed_out_pid, 0)

            spans, _ = orchestrator.detect_sources(
                [
                    TextSource("query", "Alice Person"),
                    TextSource("document", "Alice Person"),
                ]
            )
            restarted_pid = orchestrator.active_worker_pid(detector)
            self.assertIsNotNone(restarted_pid)
            self.assertNotEqual(restarted_pid, timed_out_pid)
            self.assertEqual(
                {(span.source, span.entity_type) for span in spans},
                {("query", "PERSON"), ("document", "PERSON")},
            )

            orchestrator.detect_sources(
                [TextSource("query", "Alice Person")]
            )
            self.assertEqual(
                orchestrator.active_worker_pid(detector),
                restarted_pid,
            )
        finally:
            orchestrator.close()
        self.assertIsNone(orchestrator.active_worker_pid(detector))
        if restarted_pid is not None:
            with self.assertRaises(ProcessLookupError):
                os.kill(restarted_pid, 0)

    @unittest.skipUnless(os.name == "posix", "classifier worker requires POSIX")
    def test_optional_classifier_timeout_returns_deterministic_results(self) -> None:
        def infer(_: str):  # type: ignore[no-untyped-def]
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(60)
            return []

        detector = PrivacyFilterDetector(required=False, inference=infer)
        orchestrator = DetectorOrchestrator(
            [RuleDetector(), detector],
            timeout_seconds=0.2,
        )
        try:
            started = time.monotonic()
            spans, _ = orchestrator.detect_sources(
                [TextSource("query", "Email guest@example.test")]
            )
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertIn("EMAIL", {span.entity_type for span in spans})
            self.assertIsNone(orchestrator.active_worker_pid(detector))
            worker_pid = orchestrator.last_worker_pid(detector)
            self.assertIsNotNone(worker_pid)
            assert worker_pid is not None
            with self.assertRaises(ProcessLookupError):
                os.kill(worker_pid, 0)
        finally:
            orchestrator.close()

    @unittest.skipUnless(os.name == "posix", "detector workers require POSIX")
    def test_required_detector_timeout_is_fail_closed(self) -> None:
        class SlowDetector:
            name = "slow"
            required = True

            def detect(self, text, context):  # type: ignore[no-untyped-def]
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                time.sleep(60)
                return []

        detector = SlowDetector()
        orchestrator = DetectorOrchestrator(
            [detector],
            timeout_seconds=0.2,
        )
        try:
            started = time.monotonic()
            with self.assertRaises(DetectorExecutionError):
                orchestrator.detect_sources([TextSource("query", "hello")])
            self.assertLess(time.monotonic() - started, 1.0)
            worker_pid = orchestrator.last_worker_pid(detector)
            self.assertIsNotNone(worker_pid)
            self.assertIsNone(orchestrator.active_worker_pid(detector))
            assert worker_pid is not None
            with self.assertRaises(ProcessLookupError):
                os.kill(worker_pid, 0)
        finally:
            orchestrator.close()

    @unittest.skipUnless(os.name == "posix", "detector workers require POSIX")
    def test_optional_regular_timeout_preserves_required_results(self) -> None:
        class SlowOptionalDetector:
            name = "slow_optional"
            required = False

            def detect(self, text, context):  # type: ignore[no-untyped-def]
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                time.sleep(60)
                return []

        rule = RuleDetector()
        slow = SlowOptionalDetector()
        orchestrator = DetectorOrchestrator(
            [rule, slow],
            timeout_seconds=0.2,
        )
        rule_pid: int | None = None
        try:
            started = time.monotonic()
            spans, _ = orchestrator.detect_sources(
                [TextSource("query", "Email guest@example.test")]
            )
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertIn("EMAIL", {span.entity_type for span in spans})
            rule_pid = orchestrator.active_worker_pid(rule)
            slow_pid = orchestrator.last_worker_pid(slow)
            self.assertIsNotNone(rule_pid)
            self.assertIsNotNone(slow_pid)
            self.assertIsNone(orchestrator.active_worker_pid(slow))
            assert slow_pid is not None
            with self.assertRaises(ProcessLookupError):
                os.kill(slow_pid, 0)
        finally:
            orchestrator.close()
        self.assertIsNone(orchestrator.active_worker_pid(rule))
        if rule_pid is not None:
            with self.assertRaises(ProcessLookupError):
                os.kill(rule_pid, 0)


class PolicyTests(unittest.TestCase):
    def test_overlap_merges_union_and_critical_rule_wins(self) -> None:
        spans = [
            Span(
                source="document",
                start=4,
                end=20,
                entity_type="ACCOUNT_ID",
                confidence=0.99,
                detector="privacy_filter",
                severity=Severity.HIGH,
            ),
            Span(
                source="document",
                start=0,
                end=19,
                entity_type="PAYMENT_CARD",
                confidence=1.0,
                detector="rule",
                severity=Severity.CRITICAL,
                validated=True,
            ),
        ]
        fused = fuse_spans(spans)
        self.assertEqual(len(fused), 1)
        self.assertEqual((fused[0].start, fused[0].end), (0, 20))
        self.assertEqual(fused[0].entity_type, "PAYMENT_CARD")
        decision = PolicyEngine().resolve(spans)[0]
        self.assertIs(decision.action, Action.BLOCK)

    def test_adjacent_spans_remain_separate(self) -> None:
        spans = [
            Span("query", 0, 5, "PERSON", 1.0, "rule", Severity.HIGH, True),
            Span("query", 5, 10, "EMAIL", 1.0, "rule", Severity.HIGH, True),
        ]
        self.assertEqual(len(fuse_spans(spans)), 2)

    def test_unknown_high_risk_fails_closed(self) -> None:
        span = Span(
            "query",
            0,
            5,
            "UNKNOWN_HIGH_RISK",
            0.9,
            "privacy_filter",
            Severity.CRITICAL,
        )
        self.assertIs(PolicyEngine().resolve([span])[0].action, Action.BLOCK)

    def test_policy_cannot_weaken_critical_or_private_entities(self) -> None:
        with self.assertRaises(ValueError):
            PolicyEngine(actions={"PAYMENT_CARD": Action.ALLOW})
        with self.assertRaises(ValueError):
            PolicyEngine(actions={"CREDENTIAL": Action.TOKENIZE})
        with self.assertRaises(ValueError):
            PolicyEngine(actions={"PERSON": Action.ALLOW})
        engine = PolicyEngine()
        with self.assertRaises(TypeError):
            engine.actions["PAYMENT_CARD"] = Action.ALLOW  # type: ignore[index]
        with self.assertRaises(ValueError):
            PolicyEngine(actions={"UNREGISTERED_IDENTIFIER": Action.TOKENIZE})
        with self.assertRaises(ValueError):
            PolicyEngine(version="unsafe policy version")

    def test_policy_rejects_invalid_or_weakened_critical_thresholds(self) -> None:
        with self.assertRaises(ValueError):
            PolicyEngine(thresholds={"PERSON": float("nan")})
        with self.assertRaises(ValueError):
            PolicyEngine(thresholds={"CREDENTIAL": 0.9})
        with self.assertRaises(ValueError):
            PolicyEngine(thresholds={"UNREGISTERED_IDENTIFIER": 0.8})


if __name__ == "__main__":
    unittest.main()
