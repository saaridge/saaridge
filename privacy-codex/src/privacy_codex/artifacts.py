from __future__ import annotations

import base64
import binascii
import json
import os
import re
import secrets
import shutil
import tempfile
import unicodedata
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .detectors import iter_valid_payment_card_candidates
from .errors import ArtifactSecurityError, InputRejectedError
from .io import reject_unsafe_semantic_encodings
from .models import RunPaths


class ArtifactError(ArtifactSecurityError):
    """Base error for artifact persistence failures."""


class SensitiveArtifactError(ArtifactError):
    """Raised when encrypted artifact storage is unavailable or misconfigured."""


class UnsafeArtifactError(ArtifactError):
    """Raised when content intended for a safe artifact appears sensitive."""


_ENCRYPTED_MAGIC = b"PCDX1\x00"
_KEY_ENVIRONMENT_VARIABLE = "PRIVACY_CODEX_MASTER_KEY"
_SAFE_FILE_MODE = 0o600
_SAFE_DIRECTORY_MODE = 0o700
_RUNS_MARKER = ".privacy-codex-runs"
_RUNS_MARKER_CONTENT = b"privacy-codex-runs/v1\n"
_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b"),
    re.compile(
        r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,255}|"
        r"github_pat_[A-Za-z0-9_]{20,255})(?![A-Za-z0-9_])"
    ),
    re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])"),
    re.compile(
        r"(?<![A-Za-z0-9_-])(?:AIza[0-9A-Za-z_-]{35}|"
        r"glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
        r"sk_(?:live|test)_[A-Za-z0-9]{16,})(?![A-Za-z0-9_-])"
    ),
    re.compile(
        r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|"
        r"mssql)://[^:/\s@]+:[^@\s/]+@[^\s\"'<>]+",
        re.IGNORECASE,
    ),
    re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w-])"),
)
_CREDENTIAL_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(?<![\w-])[\"']?(?:"
    r"api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|"
    r"(?:[A-Za-z][A-Za-z0-9]{0,31}[_-])?(?:password|passwd|pwd)"
    r")[\"']?\s*(?:[:=]|\bis\b)\s*"
    r"(?P<value>\"[^\"\r\n]{4,}\"|'[^'\r\n]{4,}'|[^\s,;}\]]{4,})"
)
_CLI_PASSWORD_PATTERN = re.compile(
    r"(?i)(?<!\w)(?:--password|--passwd|--pwd)(?:\s*=\s*|\s+)"
    r"(?P<value>\"[^\"\r\n]{4,}\"|'[^'\r\n]{4,}'|[^\s,;}\]]{4,})"
)
_PCI_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(?<![\w-])[\"']?(?:cvv2?|cvc2?|card[_ -]?security[_ -]?code|"
    r"card[_ -]?verification[_ -]?(?:value|code))[\"']?"
    r"\s*(?:[:=]|\bis\b)\s*[\"']?\d{3,4}(?!\d)"
)
_REDACTION_PLACEHOLDER_PATTERN = re.compile(
    r"__(?:PII|REMOVED)_[A-Z][A-Z0-9_]*__"
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_retention(value: str | timedelta) -> timedelta:
    """Parse a compact retention value such as ``7d``, ``12h`` or ``30m``."""

    if isinstance(value, timedelta):
        if value.total_seconds() < 0:
            raise ValueError("retention must not be negative")
        return value
    match = re.fullmatch(r"\s*(\d+)\s*([smhdw])\s*", value, re.IGNORECASE)
    if match is None:
        raise ValueError("retention must use one of: 30m, 12h, 7d, 2w")
    quantity = int(match.group(1))
    multiplier = {
        "s": 1,
        "m": 60,
        "h": 60 * 60,
        "d": 24 * 60 * 60,
        "w": 7 * 24 * 60 * 60,
    }[match.group(2).lower()]
    return timedelta(seconds=quantity * multiplier)


def validate_sensitive_artifact_configuration(
    environ: Mapping[str, str] | None = None,
) -> None:
    """Fail before input processing when encrypted logging cannot be initialized."""

    _create_aesgcm(dict(os.environ if environ is None else environ))


class ArtifactStore:
    """Create and securely write one privacy-codex run directory.

    Sanitized writes reject caller-registered sensitive values and common
    credential patterns. Raw artifacts are only available when explicitly
    enabled and are always encrypted with AES-256-GCM.
    """

    def __init__(
        self,
        runs_dir: Path | str,
        *,
        allow_sensitive_logs: bool = False,
        run_id: str | None = None,
        environ: Mapping[str, str] | None = None,
        sensitive_values: Iterable[str] = (),
        retention: str | timedelta = "7d",
    ) -> None:
        self.runs_dir = Path(runs_dir)
        self.allow_sensitive_logs = allow_sensitive_logs
        self.retention = parse_retention(retention)
        environment = dict(os.environ if environ is None else environ)
        self._sensitive_values = _prepare_sensitive_values(sensitive_values)
        self.run_id = run_id or _new_run_id()
        _validate_run_id(self.run_id)
        self._cipher: Any | None = None
        if allow_sensitive_logs:
            self._cipher = _create_aesgcm(environment)

        _ensure_runs_root(self.runs_dir)
        root = self.runs_dir / self.run_id
        if root.exists():
            raise ArtifactError(f"run directory already exists: {self.run_id}")
        _secure_directory(root)
        sanitized = root / "sanitized"
        sensitive = root / "sensitive"
        report = root / "report"
        for directory in (sanitized, sensitive, report):
            _secure_directory(directory)
        self.paths = RunPaths(
            root=root,
            sanitized=sanitized,
            sensitive=sensitive,
            report=report,
        )
        self.created_at = utc_now()
        self.write_manifest({})

    def register_sensitive_values(self, values: Iterable[str]) -> None:
        merged = set(self._sensitive_values)
        merged.update(_prepare_sensitive_values(values))
        self._sensitive_values = tuple(sorted(merged, key=len, reverse=True))

    def write_manifest(self, values: Mapping[str, Any]) -> Path:
        manifest: dict[str, Any] = dict(values)
        manifest.update(
            {
                "artifact_schema": "privacy-codex/run/v1",
                "run_id": self.run_id,
                "created_at": self.created_at.isoformat().replace("+00:00", "Z"),
                "sensitive_logging": self.allow_sensitive_logs,
                "retention_seconds": int(self.retention.total_seconds()),
            }
        )
        return self._write_safe_json(self.paths.root / "manifest.json", manifest)

    def append_stage(self, record: Mapping[str, Any]) -> Path:
        required = {"stage", "sequence", "timestamp", "duration_ms"}
        missing = required - set(record)
        if missing:
            raise ArtifactError(f"stage record is missing required fields: {sorted(missing)}")
        payload = dict(record)
        self._assert_safe(payload)
        encoded = _encode_json(payload) + b"\n"
        path = self.paths.root / "stages.jsonl"
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_APPEND | os.O_CREAT,
            _SAFE_FILE_MODE,
        )
        try:
            os.chmod(path, _SAFE_FILE_MODE)
            _write_all(descriptor, encoded)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return path

    def record_stage(
        self,
        stage: str,
        sequence: int,
        *,
        duration_ms: float,
        input_hash: str | None = None,
        output_hash: str | None = None,
        versions: Mapping[str, str] | None = None,
        entity_counts: Mapping[str, int] | None = None,
        actions: Mapping[str, int] | None = None,
        error_category: str | None = None,
        thread_id: str | None = None,
        exit_code: int | None = None,
        usage: Mapping[str, int | float] | None = None,
        timestamp: datetime | None = None,
    ) -> Path:
        record: dict[str, Any] = {
            "stage": stage,
            "sequence": sequence,
            "timestamp": (timestamp or utc_now()).isoformat().replace("+00:00", "Z"),
            "duration_ms": round(float(duration_ms), 3),
        }
        optional: dict[str, Any] = {
            "input_hash": input_hash,
            "output_hash": output_hash,
            "versions": dict(versions) if versions is not None else None,
            "entity_counts": dict(entity_counts) if entity_counts is not None else None,
            "actions": dict(actions) if actions is not None else None,
            "error_category": error_category,
            "thread_id": thread_id,
            "exit_code": exit_code,
            "usage": dict(usage) if usage is not None else None,
        }
        record.update({key: value for key, value in optional.items() if value is not None})
        return self.append_stage(record)

    def write_redacted_prompt(self, text: str) -> Path:
        return self._write_safe_text(
            self.paths.sanitized / "redacted-prompt.txt",
            text,
        )

    def write_detections(self, detections: Any) -> Path:
        return self._write_safe_json(
            self.paths.sanitized / "detections.json",
            detections,
        )

    def write_codex_events(self, events: Any) -> Path:
        path = self.paths.sanitized / "codex-events.jsonl"
        lines: list[bytes] = []
        for event in events:
            self._assert_safe(event)
            lines.append(_encode_json(event) + b"\n")
        return _atomic_write(path, b"".join(lines))

    def write_agent_output_redacted(self, text: str) -> Path:
        return self._write_safe_text(
            self.paths.sanitized / "agent-output-redacted.txt",
            text,
        )

    def write_metrics(self, metrics: Any) -> Path:
        return self._write_safe_json(self.paths.root / "metrics.json", metrics)

    def write_report_json(self, name: str, report: Any) -> Path:
        return self._write_safe_json(
            self.paths.report / _safe_leaf(name, suffix=".json"),
            report,
        )

    def write_report_text(self, name: str, report: str) -> Path:
        return self._write_safe_text(self.paths.report / _safe_leaf(name), report)

    def write_sensitive(self, name: str, value: str | bytes) -> Path:
        if not self.allow_sensitive_logs or self._cipher is None:
            raise SensitiveArtifactError(
                "sensitive artifact logging is disabled; use --allow-sensitive-logs "
                f"and set {_KEY_ENVIRONMENT_VARIABLE}"
            )
        leaf = _safe_leaf(name)
        if leaf.endswith(".enc"):
            logical_name = leaf[:-4]
        else:
            logical_name = leaf
            leaf = f"{leaf}.enc"
        plaintext = value.encode("utf-8") if isinstance(value, str) else bytes(value)
        nonce = secrets.token_bytes(12)
        associated_data = self._associated_data(logical_name)
        ciphertext = self._cipher.encrypt(nonce, plaintext, associated_data)
        return _atomic_write(
            self.paths.sensitive / leaf,
            _ENCRYPTED_MAGIC + nonce + ciphertext,
        )

    def decrypt_sensitive(self, name: str) -> bytes:
        """Decrypt one artifact for local evaluation/tests; never logs plaintext."""

        if not self.allow_sensitive_logs or self._cipher is None:
            raise SensitiveArtifactError("sensitive artifact logging is disabled")
        leaf = _safe_leaf(name)
        logical_name = leaf[:-4] if leaf.endswith(".enc") else leaf
        encrypted_name = leaf if leaf.endswith(".enc") else f"{leaf}.enc"
        payload = (self.paths.sensitive / encrypted_name).read_bytes()
        if not payload.startswith(_ENCRYPTED_MAGIC) or len(payload) < len(_ENCRYPTED_MAGIC) + 13:
            raise SensitiveArtifactError("encrypted artifact has an invalid envelope")
        offset = len(_ENCRYPTED_MAGIC)
        nonce = payload[offset : offset + 12]
        ciphertext = payload[offset + 12 :]
        try:
            return bytes(
                self._cipher.decrypt(
                    nonce,
                    ciphertext,
                    self._associated_data(logical_name),
                )
            )
        except Exception as error:
            raise SensitiveArtifactError("encrypted artifact authentication failed") from error

    def purge(self, older_than: str | timedelta | None = None) -> list[str]:
        return purge_runs(
            self.runs_dir,
            older_than=self.retention if older_than is None else older_than,
        )

    def _associated_data(self, logical_name: str) -> bytes:
        return f"privacy-codex:{self.run_id}:{logical_name}".encode("utf-8")

    def _write_safe_json(self, path: Path, value: Any) -> Path:
        self._assert_safe(value)
        return _atomic_write(path, _encode_json(value) + b"\n")

    def _write_safe_text(self, path: Path, value: str) -> Path:
        self._assert_safe(value)
        return _atomic_write(path, value.encode("utf-8"))

    def _assert_safe(self, value: Any) -> None:
        if isinstance(value, str):
            fragments = [value]
            registered_fragments = fragments
        else:
            try:
                json.dumps(
                    value,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    default=str,
                )
            except (TypeError, ValueError) as error:
                raise UnsafeArtifactError("safe artifact is not JSON serializable") from error
            fragments = list(_text_fragments(value))
            registered_fragments = fragments + list(_float_fragments(value))
        if _contains_sensitive_mapping(value):
            raise UnsafeArtifactError(
                "safe artifact contains a credential-like structured field"
            )
        for rendered in fragments:
            try:
                reject_unsafe_semantic_encodings(rendered)
            except InputRejectedError as error:
                raise UnsafeArtifactError(
                    "safe artifact contains an unsafe semantic encoding"
                ) from error
        for rendered in registered_fragments:
            normalized_rendered = unicodedata.normalize("NFKC", rendered).casefold()
            formatless_rendered = _remove_format_controls(normalized_rendered)
            whitespace_rendered = re.sub(
                r"\s+",
                " ",
                formatless_rendered,
            ).strip()
            compact_rendered = "".join(
                character for character in normalized_rendered if character.isalnum()
            )
            for sensitive in self._sensitive_values:
                normalized_sensitive = unicodedata.normalize(
                    "NFKC", sensitive
                ).casefold()
                formatless_sensitive = _remove_format_controls(normalized_sensitive)
                whitespace_sensitive = re.sub(
                    r"\s+",
                    " ",
                    formatless_sensitive,
                ).strip()
                compact_sensitive = "".join(
                    character
                    for character in normalized_sensitive
                    if character.isalnum()
                )
                if (
                    _contains_boundary_value(
                        normalized_rendered, normalized_sensitive
                    )
                    or _contains_boundary_value(
                        formatless_rendered, formatless_sensitive
                    )
                    or _contains_boundary_value(
                        whitespace_rendered,
                        whitespace_sensitive,
                    )
                    or (
                        len(compact_sensitive) >= 7
                        and compact_sensitive in compact_rendered
                    )
                ):
                    raise UnsafeArtifactError(
                        "safe artifact contains a caller-registered sensitive value"
                    )
        for rendered in fragments:
            for pattern in _SECRET_PATTERNS:
                if pattern.search(rendered):
                    raise UnsafeArtifactError(
                        "safe artifact contains content matching a sensitive-data pattern"
                    )
            for match in _CREDENTIAL_ASSIGNMENT_PATTERN.finditer(rendered):
                assigned_value = match.group("value").strip("\"'[]<>").lower()
                if (
                    assigned_value
                    in {
                        "0",
                        "absent",
                        "false",
                        "masked",
                        "none",
                        "not_present",
                        "null",
                        "redacted",
                        "removed",
                    }
                    or _REDACTION_PLACEHOLDER_PATTERN.fullmatch(
                        match.group("value").strip("\"'")
                    )
                ):
                    continue
                raise UnsafeArtifactError(
                    "safe artifact contains content matching a sensitive-data pattern"
                )
            if _CLI_PASSWORD_PATTERN.search(rendered):
                raise UnsafeArtifactError(
                    "safe artifact contains content matching a sensitive-data pattern"
                )
            if _PCI_ASSIGNMENT_PATTERN.search(rendered):
                raise UnsafeArtifactError(
                    "safe artifact contains content matching a sensitive-data pattern"
                )
            if _contains_payment_card(rendered):
                raise UnsafeArtifactError(
                    "safe artifact contains a Luhn-valid payment-card candidate"
                )


def purge_runs(
    runs_dir: Path | str,
    *,
    older_than: str | timedelta = "7d",
    now: datetime | None = None,
) -> list[str]:
    """Remove expired run directories without following symlinks."""

    root = Path(runs_dir)
    if not root.exists():
        return []
    resolved_root = root.resolve()
    if _is_unsafe_purge_root(resolved_root):
        raise ArtifactError(f"refusing to purge unsafe root: {resolved_root}")
    marker = root / _RUNS_MARKER
    if (
        marker.is_symlink()
        or not marker.is_file()
        or marker.read_bytes() != _RUNS_MARKER_CONTENT
    ):
        raise ArtifactError(
            "refusing to purge a directory not owned by privacy-codex"
        )
    cutoff = (now or utc_now()) - parse_retention(older_than)
    removed: list[str] = []
    for candidate in sorted(root.iterdir(), key=lambda item: item.name):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        try:
            if candidate.resolve().parent != resolved_root:
                continue
            created_at = _run_created_at(candidate)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if created_at > cutoff:
            continue
        shutil.rmtree(candidate)
        removed.append(candidate.name)
    return removed


def _new_run_id() -> str:
    timestamp = utc_now().strftime("%Y%m%dT%H%M%S%fZ")
    return f"{timestamp}-{uuid4().hex[:12]}"


def _prepare_sensitive_values(values: Iterable[str]) -> tuple[str, ...]:
    prepared = {
        unicodedata.normalize("NFKC", value)
        for value in values
        if isinstance(value, str) and value and value.strip()
    }
    return tuple(sorted(prepared, key=len, reverse=True))


def _text_fragments(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield str(key)
            yield from _text_fragments(child)
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            yield from _text_fragments(child)
    elif isinstance(value, int) and not isinstance(value, bool):
        yield str(value)


def _float_fragments(value: Any) -> Iterable[str]:
    if isinstance(value, Mapping):
        for child in value.values():
            yield from _float_fragments(child)
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            yield from _float_fragments(child)
    elif isinstance(value, float):
        yield str(value)


def _contains_boundary_value(rendered: str, sensitive: str) -> bool:
    if not sensitive:
        return False
    search_from = 0
    while True:
        start = rendered.find(sensitive, search_from)
        if start < 0:
            return False
        end = start + len(sensitive)
        left_ok = (
            start == 0
            or not sensitive[0].isalnum()
            or not rendered[start - 1].isalnum()
        )
        right_ok = (
            end == len(rendered)
            or not sensitive[-1].isalnum()
            or not rendered[end].isalnum()
        )
        if left_ok and right_ok:
            return True
        search_from = start + 1


def _remove_format_controls(value: str) -> str:
    return "".join(
        character
        for character in value
        if unicodedata.category(character) != "Cf"
    )


def _normalize_structured_key(value: Any) -> str:
    rendered = unicodedata.normalize("NFKC", str(value)).strip()
    rendered = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", rendered)
    rendered = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", rendered)
    return re.sub(r"[^a-z0-9]+", "_", rendered.casefold()).strip("_")


def _contains_sensitive_mapping(value: Any) -> bool:
    sensitive_keys = {
        "api_key",
        "apikey",
        "access_token",
        "accesstoken",
        "auth_token",
        "authtoken",
        "client_secret",
        "clientsecret",
        "password",
        "passwd",
        "pwd",
        "private_key",
        "privatekey",
        "secret",
        "cvv",
        "cvv2",
        "cvc",
        "cvc2",
        "card_security_code",
        "cardsecuritycode",
        "card_verification_value",
        "cardverificationvalue",
        "card_verification_code",
        "cardverificationcode",
        "payment_card",
        "paymentcard",
        "card_number",
        "cardnumber",
    }
    safe_values = {
        "",
        "0",
        "absent",
        "false",
        "masked",
        "none",
        "not_present",
        "null",
        "redacted",
        "removed",
    }
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized_key = _normalize_structured_key(key)
            if normalized_key in sensitive_keys:
                rendered = str(child).strip("\"'[]<>").casefold()
                if (
                    rendered not in safe_values
                    and not _REDACTION_PLACEHOLDER_PATTERN.fullmatch(str(child))
                ):
                    return True
            if _contains_sensitive_mapping(child):
                return True
    elif isinstance(value, (list, tuple, set)):
        return any(_contains_sensitive_mapping(child) for child in value)
    return False


def _validate_run_id(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise ArtifactError("run_id must be a simple 1-128 character identifier")
    if value in {".", ".."}:
        raise ArtifactError("run_id must not be a relative path segment")


def _safe_leaf(value: str, *, suffix: str | None = None) -> str:
    if not value or Path(value).name != value or value in {".", ".."}:
        raise ArtifactError("artifact name must be a filename without path separators")
    if "\x00" in value:
        raise ArtifactError("artifact name contains a null byte")
    return value if suffix is None or value.endswith(suffix) else f"{value}{suffix}"


def _secure_directory(path: Path) -> None:
    path.mkdir(mode=_SAFE_DIRECTORY_MODE, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ArtifactError(f"artifact directory is not a regular directory: {path}")
    os.chmod(path, _SAFE_DIRECTORY_MODE)


def _ensure_runs_root(path: Path) -> None:
    existed = path.exists()
    path.mkdir(mode=_SAFE_DIRECTORY_MODE, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ArtifactError(f"runs root is not a regular directory: {path}")
    if not existed:
        os.chmod(path, _SAFE_DIRECTORY_MODE)
    marker = path / _RUNS_MARKER
    if marker.exists():
        if (
            marker.is_symlink()
            or not marker.is_file()
            or marker.read_bytes() != _RUNS_MARKER_CONTENT
        ):
            raise ArtifactError("runs root has an invalid ownership marker")
    else:
        descriptor = os.open(
            marker,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            _SAFE_FILE_MODE,
        )
        try:
            _write_all(descriptor, _RUNS_MARKER_CONTENT)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def ensure_runs_root(path: Path | str) -> Path:
    root = Path(path)
    _ensure_runs_root(root)
    return root


def _atomic_write(path: Path, payload: bytes) -> Path:
    _secure_directory(path.parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, _SAFE_FILE_MODE)
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        os.chmod(path, _SAFE_FILE_MODE)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise
    return path


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("failed to write artifact")
        view = view[written:]


def _encode_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=_json_default,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ArtifactError("artifact is not JSON serializable") from error


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, Path):
        return str(value)
    safe_dict = getattr(value, "safe_dict", None)
    if callable(safe_dict):
        return safe_dict()
    raise TypeError(f"unsupported value type: {type(value).__name__}")


def _create_aesgcm(environ: Mapping[str, str]) -> Any:
    encoded_key = environ.get(_KEY_ENVIRONMENT_VARIABLE)
    if not encoded_key:
        raise SensitiveArtifactError(
            f"{_KEY_ENVIRONMENT_VARIABLE} must contain a base64 or hexadecimal "
            "32-byte key when sensitive logging is enabled"
        )
    key = _decode_master_key(encoded_key)
    if len(key) != 32:
        raise SensitiveArtifactError(
            f"{_KEY_ENVIRONMENT_VARIABLE} must decode to exactly 32 bytes"
        )
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as error:
        raise SensitiveArtifactError(
            "cryptography with AES-GCM support is required for sensitive logging"
        ) from error
    return AESGCM(key)


def _decode_master_key(value: str) -> bytes:
    candidate = value.strip()
    try:
        if candidate.startswith("hex:"):
            return bytes.fromhex(candidate[4:])
        if re.fullmatch(r"[0-9a-fA-F]{64}", candidate):
            return bytes.fromhex(candidate)
        if candidate.startswith("base64:"):
            candidate = candidate[7:]
        padding = "=" * (-len(candidate) % 4)
        return base64.b64decode(candidate + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as error:
        raise SensitiveArtifactError(
            f"{_KEY_ENVIRONMENT_VARIABLE} is not valid base64 or hexadecimal"
        ) from error


def _contains_payment_card(value: str) -> bool:
    return next(iter_valid_payment_card_candidates(value), None) is not None


def _run_created_at(run_directory: Path) -> datetime:
    manifest = run_directory / "manifest.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("run manifest is missing")
    decoded = json.loads(manifest.read_text(encoding="utf-8"))
    if decoded.get("artifact_schema") not in {
        "privacy-codex/run/v1",
        "privacy-codex/evaluation/v1",
    }:
        raise ValueError("run manifest has an unsupported schema")
    if decoded.get("run_id") != run_directory.name:
        raise ValueError("run manifest does not belong to this directory")
    value = decoded.get("created_at")
    if not isinstance(value, str):
        raise ValueError("run manifest is missing created_at")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_unsafe_purge_root(path: Path) -> bool:
    home = Path.home().resolve()
    return path == Path(path.anchor) or path == home or len(path.parts) < 3
