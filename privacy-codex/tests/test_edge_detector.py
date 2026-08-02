from pathlib import Path
import unittest

from privacy_codex.edge_detector import (
    EdgeMLDetector,
    EdgePerceptronModel,
    load_edge_model,
    save_edge_model,
    train_edge_model,
)
from privacy_codex.errors import DetectorUnavailableError
from privacy_codex.models import DetectionContext


def _records() -> list[dict[str, object]]:
    return [
        {
            "text": "guest_name: Alice Morgan\nbooking_reference: XTRV123456",
            "spans": [
                {"start": 12, "end": 24, "type": "PERSON", "action": "TOKENIZE"},
                {"start": 44, "end": 53, "type": "BOOKING_ID", "action": "TOKENIZE"},
            ],
        },
        {
            "text": "guest_name: Noah Carter\nbooking_reference: XTRV123457",
            "spans": [
                {"start": 12, "end": 23, "type": "PERSON", "action": "TOKENIZE"},
                {"start": 44, "end": 53, "type": "BOOKING_ID", "action": "TOKENIZE"},
            ],
        },
    ]


class EdgeDetectorTests(unittest.TestCase):
    def test_edge_model_round_trip_and_offsets(self) -> None:
        model = train_edge_model(_records(), epochs=20)
        path = Path("work/test-edge-model.json")
        digest = save_edge_model(model, path)
        loaded = load_edge_model(path, expected_digest=digest)
        self.assertEqual(loaded.to_dict(), model.to_dict())
        detector = EdgeMLDetector(model=loaded)
        spans = detector.detect(
            "guest_name: Priya Shah\nbooking_reference: XTRV123458",
            DetectionContext(source="query"),
        )
        self.assertTrue(any(span.entity_type == "PERSON" for span in spans))
        self.assertTrue(any(span.entity_type == "BOOKING_ID" for span in spans))
        self.assertTrue(all(span.start < span.end for span in spans))

    def test_required_edge_model_requires_matching_digest(self) -> None:
        path = Path("work/test-empty-edge-model.json")
        save_edge_model(EdgePerceptronModel(["O"], {}), path)
        detector = EdgeMLDetector(path, required=True, expected_digest="0" * 64)
        with self.assertRaises(DetectorUnavailableError):
            detector.detect("guest_name: Alice", DetectionContext(source="query"))

    def test_edge_model_skips_plain_lowercase_text(self) -> None:
        model = EdgePerceptronModel(["O", "B-PERSON"], {})
        detector = EdgeMLDetector(model=model)
        text = "ordinary lowercase documentation " * 500
        self.assertEqual(detector.detect(text, DetectionContext(source="document")), [])
