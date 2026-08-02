from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from enum import Enum, IntEnum
from pathlib import Path
from typing import Any


class Action(str, Enum):
    BLOCK = "BLOCK"
    TOKENIZE = "TOKENIZE"
    REMOVE = "REMOVE"
    ALLOW = "ALLOW"


class Severity(IntEnum):
    LOW = 10
    MEDIUM = 20
    HIGH = 30
    CRITICAL = 40


class EntityType(str, Enum):
    PERSON = "PERSON"
    EMAIL = "EMAIL"
    PHONE = "PHONE"
    PRIVATE_ADDRESS = "PRIVATE_ADDRESS"
    DATE = "DATE"
    BOOKING_ID = "BOOKING_ID"
    LOYALTY_ID = "LOYALTY_ID"
    ACCOUNT_ID = "ACCOUNT_ID"
    PASSPORT_ID = "PASSPORT_ID"
    PAYMENT_CARD = "PAYMENT_CARD"
    CVV = "CVV"
    CREDENTIAL = "CREDENTIAL"
    PRIVATE_KEY = "PRIVATE_KEY"
    IP_ADDRESS = "IP_ADDRESS"
    UNKNOWN_HIGH_RISK = "UNKNOWN_HIGH_RISK"
    PUBLIC_ENTITY = "PUBLIC_ENTITY"
    NONSENSITIVE_ID = "NONSENSITIVE_ID"


CRITICAL_ENTITY_TYPES = frozenset(
    {
        EntityType.PAYMENT_CARD.value,
        EntityType.CVV.value,
        EntityType.CREDENTIAL.value,
        EntityType.PRIVATE_KEY.value,
        EntityType.UNKNOWN_HIGH_RISK.value,
    }
)
TOKENIZED_ENTITY_TYPES = frozenset(
    {
        EntityType.PERSON.value,
        EntityType.EMAIL.value,
        EntityType.PHONE.value,
        EntityType.PRIVATE_ADDRESS.value,
        EntityType.BOOKING_ID.value,
        EntityType.LOYALTY_ID.value,
        EntityType.ACCOUNT_ID.value,
        EntityType.PASSPORT_ID.value,
        EntityType.IP_ADDRESS.value,
    }
)
ALLOWED_ENTITY_TYPES = frozenset(
    {
        EntityType.PUBLIC_ENTITY.value,
        EntityType.NONSENSITIVE_ID.value,
    }
)
SAFE_METADATA_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}")


@dataclass(frozen=True)
class TextSource:
    name: str
    text: str
    language: str | None = "en"


@dataclass(frozen=True)
class DetectionContext:
    source: str
    language: str | None = "en"
    known_values: dict[str, list[str]] = field(default_factory=dict)
    evaluation_mode: bool = False


@dataclass(frozen=True)
class Span:
    source: str
    start: int
    end: int
    entity_type: str
    confidence: float
    detector: str
    severity: Severity
    validated: bool = False
    private: bool = True
    metadata: dict[str, Any] = field(default_factory=dict, compare=False)

    def __post_init__(self) -> None:
        if self.start < 0 or self.end <= self.start:
            raise ValueError("span offsets must satisfy 0 <= start < end")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("span confidence must be between 0 and 1")

    @property
    def length(self) -> int:
        return self.end - self.start

    def safe_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "start": self.start,
            "end": self.end,
            "entity_type": self.entity_type,
            "confidence": self.confidence,
            "detector": self.detector,
            "severity": self.severity.name,
            "validated": self.validated,
            "private": self.private,
            "metadata": {
                key: value
                for key, value in self.metadata.items()
                if key not in {"value", "matched_text", "original"}
            },
        }


@dataclass(frozen=True)
class Decision:
    span: Span
    action: Action
    reason: str

    def safe_dict(self) -> dict[str, Any]:
        result = self.span.safe_dict()
        result.update({"action": self.action.value, "reason": self.reason})
        return result


@dataclass
class RedactionResult:
    redacted_sources: dict[str, str]
    token_map: dict[str, str]
    detections: list[Span]
    decisions: list[Decision]
    source_hashes: dict[str, str]
    redacted_hashes: dict[str, str]
    escaped_token_like_input: bool = False
    language: str | None = "en"
    source_lengths: dict[str, int] = field(default_factory=dict)
    irreversible_tokens: list[str] = field(default_factory=list)

    def safe_dict(self) -> dict[str, Any]:
        return {
            "sources": sorted(self.redacted_sources),
            "detections": [item.safe_dict() for item in self.detections],
            "decisions": [item.safe_dict() for item in self.decisions],
            "source_hashes": self.source_hashes,
            "redacted_hashes": self.redacted_hashes,
            "source_lengths": self.source_lengths,
            "redacted_lengths": {
                name: len(value) for name, value in self.redacted_sources.items()
            },
            "character_delta": sum(
                len(value) for value in self.redacted_sources.values()
            )
            - sum(self.source_lengths.values()),
            "irreversible_token_count": len(self.irreversible_tokens),
            "entity_counts": _count_entities(self.decisions),
            "escaped_token_like_input": self.escaped_token_like_input,
            "language": self.language,
        }


@dataclass(frozen=True)
class CodexConfig:
    executable: str = "codex"
    required_version: str = "0.131.0"
    model: str = "gpt-5.6-terra"
    reasoning_effort: str = "medium"
    base_url: str = "https://llm-gateway.example.test/v1"
    allowed_gateway_hosts: tuple[str, ...] = ("llm-gateway.example.test",)
    timeout_seconds: float = 300.0
    extra_environment: dict[str, str] = field(default_factory=dict)
    preflight_gateway: bool = False


@dataclass
class AgentResult:
    output: str
    events: list[dict[str, Any]]
    unknown_events: list[dict[str, Any]]
    usage: dict[str, int | float]
    timings: dict[str, float]
    exit_code: int
    thread_id: str | None = None
    failure: str | None = None
    stderr_category: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and self.failure is None


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    synthetic: bool
    language: str
    domain: str
    difficulty: str
    task_type: str
    query: str
    document: str
    gold_spans: list[dict[str, Any]]
    expected_answer: Any
    required_facts: list[str]
    split: str = "test"

    def __post_init__(self) -> None:
        if type(self.synthetic) is not bool:
            raise ValueError("evaluation case synthetic must be a JSON boolean")
        for field_name in (
            "case_id",
            "language",
            "domain",
            "difficulty",
            "task_type",
            "query",
            "document",
            "split",
        ):
            if not isinstance(getattr(self, field_name), str):
                raise ValueError(f"evaluation case {field_name} must be a string")
        for field_name in ("case_id", "domain"):
            validate_safe_metadata_label(getattr(self, field_name), field_name)
        if self.difficulty not in {"easy", "medium", "hard"}:
            raise ValueError("evaluation difficulty must be easy, medium, or hard")
        if self.task_type not in {"qa", "extraction"}:
            raise ValueError("evaluation task_type must be qa or extraction")
        if self.split not in {"dev", "test"}:
            raise ValueError("evaluation split must be dev or test")
        if not isinstance(self.gold_spans, list):
            raise ValueError("evaluation gold_spans must be an array")
        if (
            not isinstance(self.required_facts, list)
            or not all(
                isinstance(item, str)
                and item.strip()
                and any(character.isalnum() for character in item)
                for item in self.required_facts
            )
        ):
            raise ValueError(
                "evaluation required_facts must contain nonempty textual facts"
            )
        self._validate_expected_answer()
        sources = {"query": self.query, "document": self.document}
        sensitive_values: list[str] = []
        for gold in self.gold_spans:
            if not isinstance(gold, dict):
                raise ValueError("each evaluation gold span must be an object")
            source = gold.get("source")
            entity = gold.get("type")
            start = gold.get("start")
            end = gold.get("end")
            action = gold.get("action", Action.TOKENIZE.value)
            if source not in sources:
                raise ValueError("gold span source must be query or document")
            if (
                not isinstance(entity, str)
                or entity.upper() not in {item.value for item in EntityType}
            ):
                raise ValueError("gold span type must be a supported entity type")
            if (
                not isinstance(start, int)
                or isinstance(start, bool)
                or not isinstance(end, int)
                or isinstance(end, bool)
                or start < 0
                or end <= start
                or end > len(sources[source])
            ):
                raise ValueError("gold span offsets are outside their source")
            if not isinstance(action, str):
                raise ValueError("gold span action must be a string")
            try:
                parsed_action = Action(action.upper())
            except ValueError as error:
                raise ValueError("gold span action is invalid") from error
            normalized_entity = entity.upper()
            if (
                normalized_entity in CRITICAL_ENTITY_TYPES
                and parsed_action is not Action.BLOCK
            ):
                raise ValueError("critical gold spans must use the BLOCK action")
            if (
                normalized_entity in TOKENIZED_ENTITY_TYPES
                and parsed_action is not Action.TOKENIZE
            ):
                raise ValueError(
                    "private identifier gold spans must use the TOKENIZE action"
                )
            if (
                normalized_entity in ALLOWED_ENTITY_TYPES
                and parsed_action is not Action.ALLOW
            ):
                raise ValueError("public gold spans must use the ALLOW action")
            if (
                normalized_entity == EntityType.DATE.value
                and parsed_action is not Action.TOKENIZE
            ):
                raise ValueError("private date gold spans must use TOKENIZE")
            group = gold.get("coreference_group")
            if group is not None:
                validate_safe_metadata_label(group, "coreference_group")
            if parsed_action is not Action.ALLOW:
                sensitive_values.append(sources[source][start:end])
        self._validate_metadata_is_nonsensitive(sensitive_values)

    def _validate_expected_answer(self) -> None:
        if self.task_type == "extraction":
            if (
                not isinstance(self.expected_answer, dict)
                or not self.expected_answer
                or not _is_finite_json_value(self.expected_answer)
            ):
                raise ValueError(
                    "extraction expected_answer must be a nonempty JSON object"
                )
            return
        candidates: Any = self.expected_answer
        if isinstance(candidates, dict):
            if set(candidates) != {"answer"}:
                raise ValueError(
                    "QA expected_answer object must contain only the answer field"
                )
            candidates = candidates["answer"]
        if isinstance(candidates, str):
            candidates = [candidates]
        if (
            not isinstance(candidates, list)
            or not candidates
            or not all(
                isinstance(item, str)
                and item.strip()
                and any(character.isalnum() for character in item)
                for item in candidates
            )
        ):
            raise ValueError(
                "QA expected_answer must contain at least one nonempty textual answer"
            )

    def _validate_metadata_is_nonsensitive(
        self, sensitive_values: list[str]
    ) -> None:
        labels = (self.case_id, self.domain, self.difficulty, self.task_type, self.split)
        compact_labels = [
            "".join(character for character in label.casefold() if character.isalnum())
            for label in labels
        ]
        for value in sensitive_values:
            compact_value = "".join(
                character for character in value.casefold() if character.isalnum()
            )
            if len(compact_value) < 3:
                continue
            for compact_label in compact_labels:
                if compact_value in compact_label:
                    raise ValueError(
                        "evaluation metadata must not contain labelled sensitive values"
                    )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> EvalCase:
        if not isinstance(value, dict):
            raise TypeError("evaluation case must be a JSON object")
        required = (
            "case_id",
            "synthetic",
            "domain",
            "difficulty",
            "task_type",
            "query",
            "document",
        )
        missing = [key for key in required if key not in value]
        if missing:
            raise ValueError("evaluation case is missing required fields")
        gold_spans = value.get("gold_spans", [])
        required_facts = value.get("required_facts", [])
        if not isinstance(gold_spans, list):
            raise ValueError("evaluation gold_spans must be an array")
        if not isinstance(required_facts, list):
            raise ValueError("evaluation required_facts must be an array")
        return cls(
            case_id=value["case_id"],
            synthetic=value["synthetic"],
            language=value.get("language", "en"),
            domain=value["domain"],
            difficulty=value["difficulty"],
            task_type=value["task_type"],
            query=value["query"],
            document=value["document"],
            gold_spans=[dict(item) if isinstance(item, dict) else item for item in gold_spans],
            expected_answer=value.get("expected_answer"),
            required_facts=list(required_facts),
            split=value.get("split", "test"),
        )


@dataclass
class TrialResult:
    case_id: str
    variant: str
    repeat: int
    output: str
    codex_events: list[dict[str, Any]]
    usage: dict[str, int | float]
    timings: dict[str, float]
    privacy: dict[str, Any] = field(default_factory=dict)
    utility: dict[str, Any] = field(default_factory=dict)
    failure: str | None = None
    configuration_hash: str | None = None
    order: int | None = None
    domain: str | None = None
    difficulty: str | None = None
    task_type: str | None = None
    split: str | None = None
    expected_variants: tuple[str, ...] = ()
    expected_repeats: int | None = None
    evaluation_seed: int | None = None

    def safe_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result.pop("output", None)
        result.pop("codex_events", None)
        if self.failure is not None:
            result["failure"] = _safe_label(self.failure)
        return result


@dataclass
class CaseMetrics:
    case_id: str
    domain: str
    difficulty: str
    task_type: str
    split: str
    variant: str
    privacy: dict[str, float | int | bool]
    utility: dict[str, float | int | bool]
    restoration: dict[str, float | int | bool]
    latency: dict[str, float]
    token_metrics: dict[str, float | int]
    incomplete_pairs: int = 0


@dataclass(frozen=True)
class LoadedInput:
    query: TextSource
    document: TextSource | None
    display_name: str | None = None
    original_path: str | None = None


@dataclass(frozen=True)
class RunPaths:
    root: Path
    sanitized: Path
    sensitive: Path
    report: Path


def _count_entities(decisions: list[Decision]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for decision in decisions:
        key = f"{decision.span.entity_type}:{decision.action.value}"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _safe_label(value: str) -> str:
    label = re.sub(r"[^a-z0-9_.-]+", "_", value.casefold()).strip("_")
    return (label or "unspecified_failure")[:80]


def validate_safe_metadata_label(value: Any, field_name: str) -> None:
    if not isinstance(value, str) or SAFE_METADATA_PATTERN.fullmatch(value) is None:
        raise ValueError(
            f"evaluation {field_name} must be a lowercase safe metadata label"
        )


def _is_finite_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_finite_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_finite_json_value(item)
            for key, item in value.items()
        )
    return False
