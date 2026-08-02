from __future__ import annotations

import html
import json
import os
import re
import stat
import unicodedata
from pathlib import Path
from typing import BinaryIO, TextIO

from .errors import InputRejectedError
from .models import LoadedInput, TextSource

SUPPORTED_SUFFIXES = {
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".yaml",
    ".yml",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".go",
    ".rs",
    ".rb",
    ".php",
    ".cs",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
    ".sh",
    ".zsh",
    ".sql",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".css",
}

_SEMANTIC_ESCAPE_PATTERN = re.compile(
    r"\\U[0-9A-Fa-f]{8}|\\u\{[0-9A-Fa-f]{1,8}\}"
    r"|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\/"
    r"|%[0-9A-Fa-f]{2}"
    r"|&#(?:[xX][0-9A-Fa-f]+|\d+);|&[A-Za-z][A-Za-z0-9]{1,31};"
)
_SENSITIVE_DELIMITERS = frozenset("@._:+-/=\\")


def read_text_file(path: Path, max_bytes: int = 2_000_000) -> str:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise InputRejectedError("unsupported input format")
    try:
        with path.open("rb") as handle:
            file_status = os.fstat(handle.fileno())
            if not stat.S_ISREG(file_status.st_mode):
                raise InputRejectedError("input path is not a regular file")
            if file_status.st_size > max_bytes:
                raise InputRejectedError("input exceeds the configured byte limit")
            payload = read_limited_binary(handle, max_bytes)
    except (FileNotFoundError, IsADirectoryError) as error:
        raise InputRejectedError("input path is not a regular file") from error
    return decode_text(payload)


def decode_text(payload: bytes) -> str:
    if b"\x00" in payload:
        raise InputRejectedError("binary input is not supported")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise InputRejectedError("input must be valid UTF-8") from error
    if not text.strip():
        raise InputRejectedError("input is empty")
    reject_unsafe_semantic_encodings(text)
    return text


def read_query_stdin(stream: TextIO, max_bytes: int = 2_000_000) -> str:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    binary = getattr(stream, "buffer", None)
    if binary is not None and hasattr(binary, "read"):
        return decode_text(read_limited_binary(binary, max_bytes))
    value = stream.read(max_bytes + 1)
    if "\x00" in value:
        raise InputRejectedError("binary input is not supported")
    if len(value.encode("utf-8")) > max_bytes:
        raise InputRejectedError("query exceeds the configured byte limit")
    if not value.strip():
        raise InputRejectedError("query is empty")
    reject_unsafe_semantic_encodings(value)
    return value


def reject_unsafe_semantic_encodings(text: str) -> None:
    """Reject representations that can hide values from offset-based detectors.

    V1 deliberately rejects rather than decodes these forms because decoding
    would change source offsets. Harmless Unicode punctuation escapes such as
    ``\u2014`` remain accepted; escaped letters, digits, whitespace, sensitive
    delimiters, slash escapes, and default-ignorable characters fail closed.
    """

    for character in text:
        if unicodedata.category(character) == "Cf":
            raise InputRejectedError(
                "Unicode format-control characters are unsupported in v1"
            )
        normalized_character = unicodedata.normalize("NFKC", character)
        if normalized_character != character and any(
            item.isalnum() or item in _SENSITIVE_DELIMITERS
            for item in normalized_character
        ):
            raise InputRejectedError(
                "Unicode compatibility characters that can conceal sensitive data "
                "are unsupported in v1"
            )
    for match in _SEMANTIC_ESCAPE_PATTERN.finditer(text):
        encoded = match.group(0)
        if (
            encoded.startswith(r"\U")
            or encoded.startswith(r"\u{")
            or encoded.startswith("%")
        ):
            raise InputRejectedError(
                "semantic escape sequences that can conceal sensitive data "
                "are unsupported in v1"
            )
        if encoded == r"\/":
            decoded = "/"
        elif encoded.startswith(r"\u"):
            decoded = chr(int(encoded[2:], 16))
        elif encoded.startswith(r"\x"):
            decoded = chr(int(encoded[2:], 16))
        else:
            decoded = html.unescape(encoded)
            if decoded == encoded:
                continue
        if any(
            character.isalnum()
            or character.isspace()
            or character in _SENSITIVE_DELIMITERS
            or unicodedata.category(character) == "Cf"
            or 0xD800 <= ord(character) <= 0xDFFF
            for character in decoded
        ):
            raise InputRejectedError(
                "semantic escape sequences that can conceal sensitive data "
                "are unsupported in v1"
            )


def load_inputs(
    *,
    document_path: Path | None,
    query_file: Path | None,
    query_stream: TextIO | None,
    max_bytes: int = 2_000_000,
    language: str = "en",
) -> LoadedInput:
    if query_file is not None and query_stream is not None:
        raise InputRejectedError("choose either query file or query stdin")
    if query_file is None and query_stream is None:
        raise InputRejectedError("a query file or stdin query is required")

    if query_file is not None:
        query_text = read_text_file(query_file, max_bytes)
    else:
        assert query_stream is not None
        query_text = read_query_stdin(query_stream, max_bytes)

    document = None
    display_name = None
    original_path = None
    if document_path is not None:
        document = TextSource(
            name="document",
            text=read_text_file(document_path, max_bytes),
            language=language,
        )
        display_name = document_path.name
        original_path = str(document_path.resolve())
    return LoadedInput(
        query=TextSource(name="query", text=query_text, language=language),
        document=document,
        display_name=display_name,
        original_path=original_path,
    )


def validate_json_text(text: str) -> None:
    try:
        json.loads(text)
    except json.JSONDecodeError as error:
        raise InputRejectedError("JSON input is malformed") from error


def read_limited_binary(stream: BinaryIO, max_bytes: int) -> bytes:
    data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise InputRejectedError("input exceeds the configured byte limit")
    return data
