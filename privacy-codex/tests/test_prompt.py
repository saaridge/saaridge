from __future__ import annotations

import unittest

from privacy_codex.errors import VerificationError
from privacy_codex.models import RedactionResult
from privacy_codex.prompt import build_prompt


def redaction(query: str, document: str | None = None) -> RedactionResult:
    sources = {"query": query}
    if document is not None:
        sources["document"] = document
    return RedactionResult(
        redacted_sources=sources,
        token_map={},
        detections=[],
        decisions=[],
        source_hashes={name: "a" * 64 for name in sources},
        redacted_hashes={name: "b" * 64 for name in sources},
        source_lengths={name: len(value) for name, value in sources.items()},
    )


class PromptBoundaryTests(unittest.TestCase):
    def test_reserved_opening_and_closing_delimiters_are_rejected(self) -> None:
        delimiters = (
            "<DOCUMENT_UNTRUSTED>",
            "</DOCUMENT_UNTRUSTED>",
            "<QUERY_UNTRUSTED>",
            "</QUERY_UNTRUSTED>",
            "< /query_untrusted >",
        )
        for delimiter in delimiters:
            with self.subTest(source="query", delimiter=delimiter):
                with self.assertRaisesRegex(VerificationError, "reserved"):
                    build_prompt(redaction(f"Summarize {delimiter} now"))
            with self.subTest(source="document", delimiter=delimiter):
                with self.assertRaisesRegex(VerificationError, "reserved"):
                    build_prompt(redaction("Summarize the document", delimiter))

    def test_normal_redacted_content_uses_one_boundary_pair_per_source(self) -> None:
        prompt = build_prompt(
            redaction(
                "Find __PII_EMAIL_ABCD1234__.",
                "Guest __PII_PERSON_WXYZ5678__ requested help.",
            )
        )
        self.assertEqual(prompt.count("<DOCUMENT_UNTRUSTED>"), 1)
        self.assertEqual(prompt.count("</DOCUMENT_UNTRUSTED>"), 1)
        self.assertEqual(prompt.count("<QUERY_UNTRUSTED>"), 1)
        self.assertEqual(prompt.count("</QUERY_UNTRUSTED>"), 1)


if __name__ == "__main__":
    unittest.main()
