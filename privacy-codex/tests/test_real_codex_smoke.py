from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from privacy_codex.artifacts import ArtifactStore
from privacy_codex.detectors import (
    KnownValueDetector,
    PrivacyFilterDetector,
    RuleDetector,
)
from privacy_codex.models import CodexConfig, LoadedInput, TextSource
from privacy_codex.pipeline import PrivacyPipeline
from privacy_codex.policy import PolicyEngine
from privacy_codex.runner import CodexRunner


@unittest.skipUnless(
    os.environ.get("PRIVACY_CODEX_REAL_SMOKE") == "1",
    "set PRIVACY_CODEX_REAL_SMOKE=1 to run the authorized gateway smoke test",
)
class RealCodexSyntheticSmokeTest(unittest.TestCase):
    def test_synthetic_redacted_round_trip(self) -> None:
        model_path_value = os.environ.get("PRIVACY_CODEX_MODEL_PATH")
        model_digest = os.environ.get("PRIVACY_CODEX_MODEL_DIGEST")
        gateway_url = os.environ.get("PRIVACY_CODEX_GATEWAY_URL")
        self.assertTrue(model_path_value, "PRIVACY_CODEX_MODEL_PATH is required")
        self.assertTrue(model_digest, "PRIVACY_CODEX_MODEL_DIGEST is required")
        self.assertTrue(gateway_url, "PRIVACY_CODEX_GATEWAY_URL is required")
        self.assertTrue(os.environ.get("OPENAI_API_KEY"), "OPENAI_API_KEY is required")

        model_path = Path(str(model_path_value)).resolve()
        gateway_host = urlparse(str(gateway_url)).hostname
        self.assertTrue(gateway_host, "PRIVACY_CODEX_GATEWAY_URL needs a host")
        runner = CodexRunner(
            CodexConfig(
                base_url=str(gateway_url),
                allowed_gateway_hosts=(str(gateway_host),),
                model="gpt-5.6-terra",
                reasoning_effort="medium",
                preflight_gateway=True,
            )
        )
        pipeline = PrivacyPipeline(
            detectors=[
                KnownValueDetector(),
                RuleDetector(),
                PrivacyFilterDetector(
                    model_path,
                    required=True,
                    expected_digest=str(model_digest),
                ),
            ],
            policy=PolicyEngine(),
            runner=runner,
        )
        loaded = LoadedInput(
            query=TextSource(
                "query",
                "What is the status for Alice Example and booking TRV123456?",
            ),
            document=TextSource(
                "document",
                (
                    "Guest name: Alice Example\n"
                    "Email: alice.synthetic@example.test\n"
                    "Booking ID: TRV123456\n"
                    "Status: confirmed\n"
                ),
            ),
        )

        pipeline.preflight_detectors()
        runner.preflight()
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(Path(temporary) / "runs")
            result = pipeline.run(loaded, artifact_store=store)

        self.assertTrue(result.agent.succeeded)
        self.assertNotIn("Alice Example", result.redaction.prompt)
        self.assertNotIn("alice.synthetic@example.test", result.redaction.prompt)
        self.assertNotIn("TRV123456", result.redaction.prompt)


if __name__ == "__main__":
    unittest.main()
