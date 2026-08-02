from __future__ import annotations

import base64
import json
import os
import shutil
import stat
import tempfile
import textwrap
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from privacy_codex import runner as runner_module
from privacy_codex.artifacts import (
    ArtifactError,
    ArtifactStore,
    SensitiveArtifactError,
    UnsafeArtifactError,
    parse_retention,
    purge_runs,
)
from privacy_codex.models import CodexConfig
from privacy_codex.runner import (
    CodexGatewayError,
    CodexPreflightError,
    CodexRunner,
    CodexRunnerError,
    _remove_private_workspace,
    parse_jsonl_events,
)


class ArtifactStoreTests(unittest.TestCase):
    def test_safe_layout_permissions_and_registered_value_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(
                Path(temporary) / "runs",
                run_id="run-safe",
                sensitive_values=["Alice Example"],
            )
            prompt_path = store.write_redacted_prompt("Guest __PII_PERSON_ABCD1234__")
            store.write_codex_events(
                [{"type": "future.event", "content": "__PII_PERSON_ABCD1234__"}]
            )
            store.record_stage(
                "redaction",
                1,
                duration_ms=3.5,
                input_hash="a" * 64,
                output_hash="b" * 64,
                entity_counts={"PERSON:TOKENIZE": 1},
            )

            self.assertEqual(stat.S_IMODE(store.paths.root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(prompt_path.stat().st_mode), 0o600)
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"note": "Alice Example"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"note": "aliceexample"})

    def test_sensitive_artifacts_require_valid_key_and_use_aes_gcm(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(SensitiveArtifactError):
                ArtifactStore(
                    Path(temporary) / "missing-key",
                    allow_sensitive_logs=True,
                    environ={},
                )

            key = bytes(range(32))
            environment = {
                "PRIVACY_CODEX_MASTER_KEY": base64.urlsafe_b64encode(key).decode("ascii")
            }
            store = ArtifactStore(
                Path(temporary) / "runs",
                run_id="run-encrypted",
                allow_sensitive_logs=True,
                environ=environment,
            )
            plaintext = b"Alice Example alice@example.test"
            encrypted_path = store.write_sensitive("original-input", plaintext)
            self.assertNotIn(plaintext, encrypted_path.read_bytes())
            self.assertEqual(store.decrypt_sensitive("original-input"), plaintext)
            self.assertEqual(stat.S_IMODE(encrypted_path.stat().st_mode), 0o600)

    def test_card_and_credential_patterns_are_rejected_from_safe_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(Path(temporary) / "runs", run_id="run-pattern")
            for separator in (" ", ".", "/", "_", " - "):
                card = separator.join(("4111", "1111", "1111", "1111"))
                with self.subTest(separator=separator):
                    with self.assertRaises(UnsafeArtifactError):
                        store.write_metrics({"message": f"card {card}"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics(
                    {"message": "card 4111\u202f1111\u202f1111\u202f1111"}
                )
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"message": "password=hunter2-value"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"password": "hunter2-value"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"message": "CVV: 737"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics(
                    {"message": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}
                )
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics(
                    {
                        "message": (
                            "postgresql://demo:OnlyForTest123@db.example.test/app"
                        )
                    }
                )
            store.write_metrics({"message": "password=__REMOVED_CREDENTIAL_ABCD1234__"})

    def test_registered_short_casefolded_and_numeric_values_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(
                Path(temporary) / "runs",
                sensitive_values=["Amy", "Li", "1234567890"],
            )
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"message": "AMY"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"message": "Li"})
            with self.assertRaises(UnsafeArtifactError):
                store.write_metrics({"booking": 1234567890})
            store.write_metrics({"message": "Alice and a timing", "duration": 5.176292})

    def test_registered_short_name_whitespace_variant_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(
                Path(temporary) / "runs",
                sensitive_values=["Li Bo"],
            )
            with self.assertRaises(UnsafeArtifactError):
                store.write_agent_output_redacted("Model repeated Li   Bo here")

    def test_safe_scanner_checks_mapping_keys_aliases_and_format_controls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ArtifactStore(
                Path(temporary) / "runs",
                sensitive_values=["Amy"],
            )
            unsafe_values = (
                {"Amy": "redacted"},
                {"message": "A\u200bmy"},
                {"message": "A\u2062my"},
                {"apiKey": "abcd"},
                {"clientSecret": "hunter2"},
                {"CVV": "737"},
                {"cvc2": 123},
                {"cardVerificationValue": "737"},
                {"payment_card": "not-luhn-but-sensitive"},
                {"cardNumber": "not-luhn-but-sensitive"},
            )
            for value in unsafe_values:
                with self.subTest(value=value):
                    with self.assertRaises(UnsafeArtifactError):
                        store.write_metrics(value)

            store.write_metrics(
                {
                    "apiKey": "__REMOVED_CREDENTIAL_ABCD1234__",
                    "cvv": "redacted",
                }
            )

    def test_purge_removes_only_expired_run_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runs = Path(temporary) / "runs"
            old = ArtifactStore(runs, run_id="old")
            new = ArtifactStore(runs, run_id="new")
            old.created_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
            old.write_manifest({})
            new.created_at = datetime(2025, 1, 10, tzinfo=timezone.utc)
            new.write_manifest({})

            removed = purge_runs(
                runs,
                older_than="7d",
                now=datetime(2025, 1, 11, tzinfo=timezone.utc),
            )
            self.assertEqual(removed, ["old"])
            self.assertFalse(old.paths.root.exists())
            self.assertTrue(new.paths.root.exists())

    def test_purge_refuses_unowned_root_and_preserves_unrelated_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            unowned = Path(temporary) / "unowned"
            unrelated = unowned / "old-data"
            unrelated.mkdir(parents=True)
            (unrelated / "manifest.json").write_text(
                json.dumps(
                    {
                        "artifact_schema": "privacy-codex/run/v1",
                        "created_at": "2020-01-01T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ArtifactError):
                purge_runs(
                    unowned,
                    older_than="1d",
                    now=datetime(2025, 1, 1, tzinfo=timezone.utc),
                )
            self.assertTrue(unrelated.exists())

            owned = Path(temporary) / "owned"
            store = ArtifactStore(owned, run_id="valid")
            other = owned / "unrelated"
            other.mkdir()
            removed = purge_runs(
                owned,
                older_than="0s",
                now=datetime(2030, 1, 1, tzinfo=timezone.utc),
            )
            self.assertEqual(removed, ["valid"])
            self.assertTrue(other.exists())

    def test_retention_parser(self) -> None:
        self.assertEqual(parse_retention("7d"), timedelta(days=7))
        self.assertEqual(parse_retention("12h"), timedelta(hours=12))
        with self.assertRaises(ValueError):
            parse_retention("forever")


class CodexRunnerTests(unittest.TestCase):
    def _fake_codex(self, directory: Path) -> Path:
        executable = directory / "fake-codex"
        executable.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json
                import os
                import pathlib
                import signal
                import stat
                import subprocess
                import sys
                import time

                if "--version" in sys.argv:
                    print("codex-cli 0.131.0")
                    raise SystemExit(0)

                behavior = os.environ.get("FAKE_BEHAVIOR", "success")
                if behavior == "timeout":
                    time.sleep(60)
                    raise SystemExit(0)
                if behavior == "timeout_tree":
                    child = subprocess.Popen([
                        sys.executable,
                        "-c",
                        (
                            "import signal,time;"
                            "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                            "time.sleep(60)"
                        ),
                    ])
                    pathlib.Path(os.environ["FAKE_CHILD_PID"]).write_text(
                        str(child.pid), encoding="utf-8"
                    )
                    pathlib.Path(os.environ["FAKE_PROCESS_GROUP"]).write_text(
                        str(os.getpgrp()), encoding="utf-8"
                    )
                    time.sleep(60)
                    raise SystemExit(0)
                if behavior == "nonzero":
                    print(json.dumps({"type": "turn.failed"}))
                    print("synthetic failure", file=sys.stderr)
                    raise SystemExit(3)
                if behavior == "oversize_stdout":
                    print("X" * 4096)
                if behavior == "oversize_stderr":
                    print("X" * 4096, file=sys.stderr)

                arguments = sys.argv[1:]
                prompt = sys.stdin.read()
                capture = pathlib.Path(os.environ["FAKE_CAPTURE"])
                private_names = (
                    "redacted-stdin.txt",
                    "codex-events.jsonl",
                    "codex-stderr.txt",
                    "final-redacted-output.txt",
                )
                capture.write_text(json.dumps({
                    "argv": arguments,
                    "prompt": prompt,
                    "agents": (pathlib.Path.cwd() / "AGENTS.md").is_file(),
                    "credential_present": bool(os.environ.get("CODEX_API_KEY")),
                    "isolated_home": pathlib.Path(os.environ["HOME"]).resolve()
                        == pathlib.Path.cwd().resolve(),
                    "cwd": str(pathlib.Path.cwd()),
                    "private_modes": {
                        name: stat.S_IMODE(
                            (pathlib.Path.cwd() / name).stat().st_mode
                        )
                        for name in private_names
                    },
                }), encoding="utf-8")
                if behavior == "event_flood":
                    for index in range(10):
                        print(json.dumps({
                            "type": "future.flood",
                            "index": index,
                        }))
                print(json.dumps({"type": "thread.started", "thread_id": "thread-1"}))
                print(json.dumps({"type": "future.observable", "payload": 42}))
                print(json.dumps({"type": "turn.completed", "usage": {
                    "input_tokens": 12,
                    "cached_input_tokens": 2,
                    "output_tokens": 4,
                    "reasoning_tokens": 3
                }}))
                if behavior != "missing":
                    output_index = arguments.index("-o") + 1
                    pathlib.Path(arguments[output_index]).write_text(
                        (
                            "X" * 4096
                            if behavior == "oversize_output"
                            else "Answer __PII_EMAIL_ABCD1234__"
                        ),
                        encoding="utf-8",
                    )
                """
            ),
            encoding="utf-8",
        )
        executable.chmod(0o700)
        return executable

    def test_run_uses_stdin_isolation_and_authoritative_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = self._fake_codex(directory)
            capture = directory / "capture.json"
            config = CodexConfig(
                executable=str(executable),
                extra_environment={"FAKE_CAPTURE": str(capture)},
            )
            runner = CodexRunner(
                config,
                environ={
                    "PATH": os.environ.get("PATH", ""),
                    "OPENAI_API_KEY": "local-test-token",
                },
            )
            redacted_prompt = "Find __PII_EMAIL_ABCD1234__ in the document."
            result = runner.run(redacted_prompt)
            observed = json.loads(capture.read_text(encoding="utf-8"))

            self.assertTrue(result.succeeded)
            self.assertEqual(result.output, "Answer __PII_EMAIL_ABCD1234__")
            self.assertEqual(result.thread_id, "thread-1")
            self.assertEqual(result.usage["input_tokens"], 12)
            self.assertEqual(result.unknown_events[0]["type"], "future.observable")
            self.assertEqual(observed["prompt"], redacted_prompt)
            self.assertNotIn(redacted_prompt, observed["argv"])
            self.assertTrue(observed["agents"])
            self.assertTrue(observed["credential_present"])
            self.assertTrue(observed["isolated_home"])
            self.assertEqual(
                set(observed["private_modes"].values()),
                {0o600},
            )
            self.assertFalse(Path(observed["cwd"]).exists())
            self.assertIn("--ephemeral", observed["argv"])
            self.assertIn("--strict-config", observed["argv"])
            self.assertIn("read-only", observed["argv"])
            self.assertNotIn("local-test-token", json.dumps(observed["argv"]))
            disabled = {
                observed["argv"][index + 1]
                for index, value in enumerate(observed["argv"][:-1])
                if value == "--disable"
            }
            self.assertEqual(
                disabled,
                set(runner_module._CODEX_0131_ENABLED_FEATURES),
            )
            config_values = {
                observed["argv"][index + 1]
                for index, value in enumerate(observed["argv"][:-1])
                if value == "-c"
            }
            self.assertTrue(
                {
                    'approval_policy="never"',
                    'model_provider="private-gateway"',
                    'model_providers.private-gateway.name="Private Gateway"',
                    (
                        'model_providers.private-gateway.base_url='
                        '"https://llm-gateway.example.test/v1"'
                    ),
                    (
                        'model_providers.private-gateway.env_key='
                        '"OPENAI_API_KEY"'
                    ),
                    'web_search="disabled"',
                    "tools.web_search=false",
                    "mcp_servers={}",
                    "check_for_update_on_startup=false",
                    "include_apps_instructions=false",
                    "include_collaboration_mode_instructions=false",
                    "otel.log_user_prompt=false",
                }.issubset(config_values)
            )

    def test_timeout_and_missing_final_output_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = self._fake_codex(directory)
            common_environment = {
                "PATH": os.environ.get("PATH", ""),
                "OPENAI_API_KEY": "local-test-token",
            }
            timeout_config = CodexConfig(
                executable=str(executable),
                timeout_seconds=0.1,
                extra_environment={
                    "FAKE_CAPTURE": str(directory / "timeout-capture.json"),
                    "FAKE_BEHAVIOR": "timeout",
                },
            )
            started = time.monotonic()
            timed_out = CodexRunner(
                timeout_config,
                environ=common_environment,
            ).run("redacted")
            self.assertLess(time.monotonic() - started, 3.0)
            self.assertEqual(timed_out.failure, "timeout")
            self.assertEqual(timed_out.stderr_category, "timeout")

            missing_config = CodexConfig(
                executable=str(executable),
                extra_environment={
                    "FAKE_CAPTURE": str(directory / "missing-capture.json"),
                    "FAKE_BEHAVIOR": "missing",
                },
            )
            missing = CodexRunner(
                missing_config,
                environ=common_environment,
            ).run("redacted")
            self.assertEqual(missing.failure, "missing_final_output")

            nonzero_config = CodexConfig(
                executable=str(executable),
                extra_environment={
                    "FAKE_CAPTURE": str(directory / "nonzero-capture.json"),
                    "FAKE_BEHAVIOR": "nonzero",
                },
            )
            nonzero = CodexRunner(
                nonzero_config,
                environ=common_environment,
            ).run("redacted")
            self.assertEqual(nonzero.failure, "codex_nonzero_exit")
            self.assertEqual(nonzero.exit_code, 3)

    def test_timeout_kills_the_posix_process_group_without_pipe_hang(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = self._fake_codex(directory)
            child_pid = directory / "child.pid"
            process_group = directory / "process-group.txt"
            config = CodexConfig(
                executable=str(executable),
                timeout_seconds=1.0,
                extra_environment={
                    "FAKE_BEHAVIOR": "timeout_tree",
                    "FAKE_CHILD_PID": str(child_pid),
                    "FAKE_PROCESS_GROUP": str(process_group),
                },
            )
            started = time.monotonic()
            result = CodexRunner(
                config,
                environ={
                    "PATH": os.environ.get("PATH", ""),
                    "OPENAI_API_KEY": "local-test-token",
                },
            ).run("redacted")
            self.assertLess(time.monotonic() - started, 3.0)
            self.assertEqual(result.failure, "timeout")
            self.assertTrue(child_pid.is_file())

            group_id = int(process_group.read_text(encoding="utf-8"))
            group_exists = True
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                try:
                    os.killpg(group_id, 0)
                except ProcessLookupError:
                    group_exists = False
                    break
                time.sleep(0.02)
            self.assertFalse(group_exists)

    def test_stdout_stderr_and_final_output_have_hard_limits(self) -> None:
        cases = (
            ("oversize_stdout", "_MAX_CODEX_STDOUT_BYTES"),
            ("oversize_stderr", "_MAX_CODEX_STDERR_BYTES"),
            ("oversize_output", "_MAX_CODEX_FINAL_OUTPUT_BYTES"),
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = self._fake_codex(directory)
            for behavior, limit_name in cases:
                with self.subTest(behavior=behavior):
                    config = CodexConfig(
                        executable=str(executable),
                        extra_environment={
                            "FAKE_CAPTURE": str(directory / f"{behavior}.json"),
                            "FAKE_BEHAVIOR": behavior,
                        },
                    )
                    with patch.object(runner_module, limit_name, 512):
                        result = CodexRunner(
                            config,
                            environ={
                                "PATH": os.environ.get("PATH", ""),
                                "OPENAI_API_KEY": "local-test-token",
                            },
                        ).run("redacted")
                    self.assertEqual(result.failure, "output_limit_exceeded")
                    self.assertEqual(result.stderr_category, "output_limit")

    def test_non_posix_runtime_is_rejected_before_subprocess_start(self) -> None:
        runner = CodexRunner(
            CodexConfig(),
            environ={"OPENAI_API_KEY": "local-test-token"},
        )
        with patch.object(runner_module.os, "name", "nt"):
            with self.assertRaisesRegex(CodexPreflightError, "POSIX"):
                runner.preflight()

    def test_workspace_cleanup_is_verified(self) -> None:
        workspace = Path(tempfile.mkdtemp(prefix="privacy-codex-run-"))
        try:
            with patch.object(runner_module.shutil, "rmtree", return_value=None):
                with self.assertRaisesRegex(CodexRunnerError, "could not be verified"):
                    _remove_private_workspace(workspace)
        finally:
            if workspace.exists():
                shutil.rmtree(workspace)

    def test_gateway_preflight_checks_model_without_llm_call(self) -> None:
        class Response:
            status = 200

            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_: object) -> None:
                return None

            def read(self, _: int) -> bytes:
                return json.dumps({"data": [{"id": "gpt-5.6-terra"}]}).encode()

        with tempfile.TemporaryDirectory() as temporary:
            executable = self._fake_codex(Path(temporary))
            seen_authorization: list[str] = []

            def urlopen(request: object, **_: object) -> Response:
                authorization = request.get_header("Authorization")  # type: ignore[attr-defined]
                seen_authorization.append(authorization)
                return Response()

            config = CodexConfig(
                executable=str(executable),
                preflight_gateway=True,
            )
            result = CodexRunner(
                config,
                environ={
                    "PATH": os.environ.get("PATH", ""),
                    "OPENAI_API_KEY": "local-test-token",
                },
                urlopen=urlopen,
            ).preflight()
            self.assertTrue(result["gateway_checked"])
            self.assertEqual(seen_authorization, ["Bearer local-test-token"])

            unavailable = CodexConfig(
                executable=str(executable),
                model="not-available",
                preflight_gateway=True,
            )
            with self.assertRaises(CodexGatewayError):
                CodexRunner(
                    unavailable,
                    environ={
                        "PATH": os.environ.get("PATH", ""),
                        "OPENAI_API_KEY": "local-test-token",
                    },
                    urlopen=urlopen,
                ).preflight()

    def test_vendor_endpoint_is_rejected(self) -> None:
        configs = (
            CodexConfig(
                base_url="https://api.openai.com/v1",
                allowed_gateway_hosts=("api.openai.com",),
            ),
            CodexConfig(
                base_url="https://api.openai.com./v1",
                allowed_gateway_hosts=("api.openai.com.",),
            ),
            CodexConfig(
                base_url="https://api.openai.com%2e/v1",
                allowed_gateway_hosts=("api.openai.com%2e",),
            ),
        )
        for config in configs:
            with self.subTest(base_url=config.base_url):
                runner = CodexRunner(config, environ={"OPENAI_API_KEY": "test"})
                with self.assertRaises(CodexPreflightError):
                    runner.preflight()

    def test_explicit_private_gateway_host_is_accepted(self) -> None:
        config = CodexConfig(
            base_url="https://private-gateway.corp.example.test/v1",
            allowed_gateway_hosts=("private-gateway.corp.example.test",),
        )
        command = CodexRunner(
            config,
            environ={"OPENAI_API_KEY": "local-test-token"},
        ).build_command(
            config,
            workspace=Path("/private/tmp/privacy-codex-test-workspace"),
            output_path=Path("/private/tmp/privacy-codex-test-output"),
        )
        self.assertIn(
            (
                "model_providers.private-gateway.base_url="
                '"https://private-gateway.corp.example.test/v1"'
            ),
            command,
        )

    def test_plain_http_gateway_is_limited_to_private_runtime_hosts(self) -> None:
        accepted = CodexConfig(
            base_url="http://model-router.svc/v1",
            allowed_gateway_hosts=("model-router.svc",),
        )
        CodexRunner(
            accepted,
            environ={"OPENAI_API_KEY": "local-test-token"},
        ).build_command(
            accepted,
            workspace=Path("/private/tmp/privacy-codex-test-workspace"),
            output_path=Path("/private/tmp/privacy-codex-test-output"),
        )

        rejected = CodexConfig(
            base_url="http://private-gateway.example.test/v1",
            allowed_gateway_hosts=("private-gateway.example.test",),
        )
        with self.assertRaises(CodexPreflightError):
            CodexRunner(
                rejected,
                environ={"OPENAI_API_KEY": "local-test-token"},
            ).build_command(
                rejected,
                workspace=Path("/private/tmp/privacy-codex-test-workspace"),
                output_path=Path("/private/tmp/privacy-codex-test-output"),
            )

    def test_unsafe_or_invalid_codex_metadata_fails_before_subprocess(self) -> None:
        invalid_configs = (
            CodexConfig(model="provider/gpt\ninjected"),
            CodexConfig(model="x" * 129),
            CodexConfig(reasoning_effort="ultra"),
            CodexConfig(required_version="01.131.0"),
            CodexConfig(required_version="0.131"),
            CodexConfig(timeout_seconds=0),
            CodexConfig(timeout_seconds=-1),
            CodexConfig(timeout_seconds=float("nan")),
            CodexConfig(timeout_seconds=float("inf")),
            CodexConfig(timeout_seconds=True),
            CodexConfig(allowed_gateway_hosts=()),
            CodexConfig(allowed_gateway_hosts=("https://gateway.example.test",)),
        )
        for config in invalid_configs:
            with self.subTest(config=config):
                runner = CodexRunner(
                    config,
                    environ={"OPENAI_API_KEY": "local-test-token"},
                )
                with patch.object(runner, "_check_version") as check_version:
                    with self.assertRaises(CodexPreflightError):
                        runner.preflight()
                check_version.assert_not_called()

    def test_safe_provider_model_and_semver_metadata_are_accepted(self) -> None:
        config = CodexConfig(
            model="provider/gpt-5.6:terra@2026-07",
            reasoning_effort="xhigh",
            required_version="0.131.0-rc.1+build.7",
            timeout_seconds=0.5,
        )
        command = CodexRunner(
            config,
            environ={"OPENAI_API_KEY": "local-test-token"},
        ).build_command(
            config,
            workspace=Path("/private/tmp/privacy-codex-test-workspace"),
            output_path=Path("/private/tmp/privacy-codex-test-output"),
        )
        self.assertEqual(command[command.index("-m") + 1], config.model)

    def test_malformed_and_unknown_jsonl_are_retained_safely(self) -> None:
        events, unknown = parse_jsonl_events(
            '{"type":"thread.started","thread_id":"1"}\n'
            '{"type":"new.event","field":"kept"}\n'
            "not-json\n"
        )
        self.assertEqual(len(events), 3)
        self.assertEqual(unknown[0]["field"], "kept")
        self.assertEqual(unknown[1]["type"], "privacy_codex.malformed_jsonl")
        self.assertNotIn("not-json", json.dumps(unknown))

    def test_jsonl_event_count_and_line_size_are_bounded(self) -> None:
        event_stream = "".join(
            json.dumps({"type": "future.event", "index": index}) + "\n"
            for index in range(5)
        )
        with patch.object(runner_module, "_MAX_CODEX_EVENT_COUNT", 2):
            events, unknown = parse_jsonl_events(event_stream)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[-1]["type"], "privacy_codex.jsonl_limit_exceeded")
        self.assertEqual(events[-1]["limit"], "event_count")
        self.assertEqual(unknown[-1], events[-1])
        self.assertNotIn('"index": 2', json.dumps(events))

        oversized = json.dumps(
            {"type": "future.event", "payload": "X" * 128}
        ) + "\n"
        with patch.object(runner_module, "_MAX_CODEX_EVENT_LINE_BYTES", 32):
            events, unknown = parse_jsonl_events(oversized)
        self.assertEqual(events, unknown)
        self.assertEqual(events[0]["type"], "privacy_codex.jsonl_limit_exceeded")
        self.assertEqual(events[0]["limit"], "line_bytes")
        self.assertNotIn("X", json.dumps(events))

    def test_jsonl_limit_marker_fails_the_run_safely(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = self._fake_codex(directory)
            config = CodexConfig(
                executable=str(executable),
                extra_environment={
                    "FAKE_CAPTURE": str(directory / "event-flood.json"),
                    "FAKE_BEHAVIOR": "event_flood",
                },
            )
            with patch.object(runner_module, "_MAX_CODEX_EVENT_COUNT", 3):
                result = CodexRunner(
                    config,
                    environ={
                        "PATH": os.environ.get("PATH", ""),
                        "OPENAI_API_KEY": "local-test-token",
                    },
                ).run("redacted")
            self.assertEqual(result.failure, "codex_event_limit_exceeded")
            self.assertEqual(result.stderr_category, "output_limit")
            self.assertEqual(
                result.events[-1]["type"],
                "privacy_codex.jsonl_limit_exceeded",
            )
            self.assertEqual(result.events[-1]["limit"], "event_count")


if __name__ == "__main__":
    unittest.main()
