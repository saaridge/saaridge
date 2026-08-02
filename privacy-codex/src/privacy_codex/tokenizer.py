from __future__ import annotations

import hashlib
import re
import secrets
import string
import unicodedata
from dataclasses import dataclass
from typing import Iterable

from .errors import BlockedInputError, TokenCollisionError, VerificationError
from .models import Action, Decision, RedactionResult, TextSource

TOKEN_PATTERN = re.compile(r"__(?:PII|REMOVED)_[A-Z0-9_]+__")
MUTATED_TOKEN_PATTERN = re.compile(
    r"__\s*(?:PII|REMOVED)[_\-\s]+[A-Z0-9_\-\s]{3,80}__",
    re.IGNORECASE,
)
TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


@dataclass(frozen=True)
class RestorationResult:
    text: str
    restored_count: int
    unknown_tokens: list[str]
    mutated_tokens: list[str]


class Tokenizer:
    def __init__(self, token_id_length: int = 8) -> None:
        if token_id_length < 8:
            raise ValueError("token identifiers must contain at least eight characters")
        self._token_id_length = token_id_length

    def redact(
        self,
        sources: list[TextSource],
        decisions: list[Decision],
        *,
        evaluation_mode: bool = False,
        escape_input_tokens: bool = False,
    ) -> RedactionResult:
        source_map = {source.name: source.text for source in sources}
        if len(source_map) != len(sources):
            raise ValueError("text source names must be unique")

        collisions = [
            source.name for source in sources if TOKEN_PATTERN.search(source.text)
        ]
        if collisions and not escape_input_tokens:
            raise TokenCollisionError("input contains a reserved privacy-token pattern")

        blocked = [
            decision
            for decision in decisions
            if decision.action is Action.BLOCK
        ]
        if blocked and not evaluation_mode:
            raise BlockedInputError(
                "critical sensitive data was detected; Codex invocation is blocked"
            )

        occupied_tokens = set(
            match.group(0)
            for source in sources
            for match in TOKEN_PATTERN.finditer(source.text)
        )
        key_to_token: dict[tuple[str, str], str] = {}
        token_map: dict[str, str] = {}
        irreversible_tokens: list[str] = []
        replacements: dict[str, list[tuple[int, int, str]]] = {
            source.name: [] for source in sources
        }

        for decision in sorted(
            decisions,
            key=lambda item: (
                item.span.source,
                item.span.start,
                item.span.end,
                -int(item.span.severity),
            ),
        ):
            if decision.action is Action.ALLOW:
                continue
            original_text = source_map.get(decision.span.source)
            if original_text is None or decision.span.end > len(original_text):
                raise VerificationError("a detection span does not match its source")
            original = original_text[decision.span.start : decision.span.end]
            action = decision.action
            if action is Action.BLOCK and evaluation_mode:
                action = Action.REMOVE

            if action is Action.TOKENIZE:
                normalized = normalize_sensitive_value(
                    original, decision.span.entity_type
                )
                coreference = str(
                    decision.span.metadata.get("coreference_group", "")
                )
                identity = coreference or normalized
                key = (decision.span.entity_type, identity)
                token = key_to_token.get(key)
                if token is None:
                    token = self._new_token(
                        "PII", decision.span.entity_type, occupied_tokens
                    )
                    key_to_token[key] = token
                    token_map[token] = original
                    occupied_tokens.add(token)
                replacement = token
            elif action is Action.REMOVE:
                replacement = self._new_token(
                    "REMOVED", decision.span.entity_type, occupied_tokens
                )
                occupied_tokens.add(replacement)
                irreversible_tokens.append(replacement)
            else:
                continue
            replacements[decision.span.source].append(
                (decision.span.start, decision.span.end, replacement)
            )

        redacted_sources: dict[str, str] = {}
        for source in sources:
            value = source.text
            if escape_input_tokens:
                value = _escape_reserved_tokens_same_length(value)
            last_start = len(value) + 1
            for start, end, replacement in sorted(
                replacements[source.name], key=lambda item: item[0], reverse=True
            ):
                if end > last_start:
                    raise VerificationError(
                        "overlapping redaction decisions were not fused"
                    )
                value = value[:start] + replacement + value[end:]
                last_start = start
            redacted_sources[source.name] = value

        result = RedactionResult(
            redacted_sources=redacted_sources,
            token_map=token_map,
            detections=[decision.span for decision in decisions],
            decisions=decisions,
            source_hashes={
                source.name: sha256_text(source.text) for source in sources
            },
            redacted_hashes={
                name: sha256_text(value) for name, value in redacted_sources.items()
            },
            escaped_token_like_input=bool(collisions),
            language=next(
                (source.language for source in sources if source.language), None
            ),
            source_lengths={source.name: len(source.text) for source in sources},
            irreversible_tokens=irreversible_tokens,
        )
        verify_redaction(sources, result)
        return result

    def _new_token(
        self, prefix: str, entity_type: str, occupied: set[str]
    ) -> str:
        safe_entity = re.sub(r"[^A-Z0-9]+", "_", entity_type.upper()).strip("_")
        for _ in range(100):
            identifier = "".join(
                secrets.choice(TOKEN_ALPHABET)
                for _ in range(self._token_id_length)
            )
            token = f"__{prefix}_{safe_entity}_{identifier}__"
            if token not in occupied:
                return token
        raise TokenCollisionError("could not allocate a unique privacy token")


def verify_redaction(
    sources: list[TextSource],
    result: RedactionResult,
    *,
    final_prompt: str | None = None,
) -> None:
    originals_by_source = {source.name: source.text for source in sources}
    verification_targets = list(result.redacted_sources.values())
    if final_prompt is not None:
        verification_targets.append(final_prompt)
    for decision in result.decisions:
        if decision.action is Action.ALLOW:
            continue
        original_source = originals_by_source[decision.span.source]
        original = original_source[decision.span.start : decision.span.end]
        normalized = normalize_for_verification(original)
        for target in verification_targets:
            if original and original in target:
                raise VerificationError(
                    "a detected sensitive value survived redaction"
                )
            if (
                normalized
                and len(normalized) >= 4
                and normalized in normalize_for_verification(target)
            ):
                raise VerificationError(
                    "a normalized sensitive value survived redaction"
                )


def restore_tokens(
    text: str,
    token_map: dict[str, str],
    irreversible_tokens: Iterable[str] = (),
) -> RestorationResult:
    restored_count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal restored_count
        token = match.group(0)
        original = token_map.get(token)
        if original is None:
            return token
        restored_count += 1
        return original

    restored = TOKEN_PATTERN.sub(replace, text)
    exact_tokens = {match.group(0) for match in TOKEN_PATTERN.finditer(text)}
    unknown = sorted(
        exact_tokens.difference(token_map).difference(irreversible_tokens)
    )
    mutated = sorted(
        {
            match.group(0)
            for match in MUTATED_TOKEN_PATTERN.finditer(text)
            if match.group(0) not in exact_tokens
        }
    )
    return RestorationResult(
        text=restored,
        restored_count=restored_count,
        unknown_tokens=unknown,
        mutated_tokens=mutated,
    )


def normalize_sensitive_value(value: str, entity_type: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip()
    if entity_type in {
        "PHONE",
        "PAYMENT_CARD",
        "BOOKING_ID",
        "LOYALTY_ID",
        "ACCOUNT_ID",
        "PASSPORT_ID",
    }:
        compact = re.sub(r"[\s().+\-_/]", "", normalized).casefold()
        if compact:
            return compact
    return re.sub(r"\s+", " ", normalized).casefold()


def normalize_for_verification(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sensitive_substrings(
    sources: Iterable[TextSource], decisions: Iterable[Decision]
) -> list[str]:
    source_map = {source.name: source.text for source in sources}
    values: list[str] = []
    for decision in decisions:
        if decision.action is Action.ALLOW:
            continue
        source = source_map.get(decision.span.source)
        if source is not None:
            values.append(source[decision.span.start : decision.span.end])
    return values


def _escape_reserved_tokens_same_length(value: str) -> str:
    return TOKEN_PATTERN.sub(
        lambda match: match.group(0).replace("__PII_", "__USR_", 1).replace(
            "__REMOVED_", "__USERMOV_", 1
        ),
        value,
    )
