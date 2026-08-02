from __future__ import annotations

import math
import re
from dataclasses import replace
from types import MappingProxyType
from typing import Iterable, Mapping

from .models import CRITICAL_ENTITY_TYPES, Action, Decision, Severity, Span

DEFAULT_ACTIONS: Mapping[str, Action] = MappingProxyType({
    "PAYMENT_CARD": Action.BLOCK,
    "CVV": Action.BLOCK,
    "CREDENTIAL": Action.BLOCK,
    "PRIVATE_KEY": Action.BLOCK,
    "UNKNOWN_HIGH_RISK": Action.BLOCK,
    "PERSON": Action.TOKENIZE,
    "EMAIL": Action.TOKENIZE,
    "PHONE": Action.TOKENIZE,
    "PRIVATE_ADDRESS": Action.TOKENIZE,
    "DATE": Action.TOKENIZE,
    "BOOKING_ID": Action.TOKENIZE,
    "LOYALTY_ID": Action.TOKENIZE,
    "ACCOUNT_ID": Action.TOKENIZE,
    "PASSPORT_ID": Action.TOKENIZE,
    "IP_ADDRESS": Action.TOKENIZE,
    "PUBLIC_ENTITY": Action.ALLOW,
    "NONSENSITIVE_ID": Action.ALLOW,
})
IMMUTABLE_BLOCK_ENTITIES = set(CRITICAL_ENTITY_TYPES)
MINIMUM_TOKENIZE_ENTITIES = {
    "PERSON",
    "EMAIL",
    "PHONE",
    "PRIVATE_ADDRESS",
    "DATE",
    "BOOKING_ID",
    "LOYALTY_ID",
    "ACCOUNT_ID",
    "PASSPORT_ID",
    "IP_ADDRESS",
}


class PolicyEngine:
    def __init__(
        self,
        *,
        version: str = "poc-en-v1",
        actions: dict[str, Action] | None = None,
        thresholds: dict[str, float] | None = None,
    ) -> None:
        if (
            not isinstance(version, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", version) is None
        ):
            raise ValueError("policy version must be a safe 1-128 character label")
        self.version = version
        overrides: dict[str, Action] = {}
        for raw_entity, raw_action in (actions or {}).items():
            entity = str(raw_entity).upper()
            if entity not in DEFAULT_ACTIONS:
                raise ValueError(f"unsupported policy entity type: {entity}")
            if not isinstance(raw_action, Action):
                raise ValueError("policy actions must be Action values")
            overrides[entity] = raw_action
        for entity, action in overrides.items():
            if entity in IMMUTABLE_BLOCK_ENTITIES and action is not Action.BLOCK:
                raise ValueError(
                    f"{entity} is an immutable BLOCK entity in the live policy"
                )
            if entity in MINIMUM_TOKENIZE_ENTITIES and action is Action.ALLOW:
                raise ValueError(
                    f"{entity} cannot be weakened to ALLOW in the live policy"
                )
        resolved_actions = {**DEFAULT_ACTIONS, **overrides}
        for entity in IMMUTABLE_BLOCK_ENTITIES:
            resolved_actions[entity] = Action.BLOCK
        self.actions: Mapping[str, Action] = MappingProxyType(resolved_actions)
        normalized_thresholds = {
            str(entity).upper(): float(value)
            for entity, value in (thresholds or {}).items()
        }
        for entity, value in normalized_thresholds.items():
            if entity not in DEFAULT_ACTIONS:
                raise ValueError(f"unsupported policy threshold entity: {entity}")
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise ValueError("policy thresholds must be finite values from 0 to 1")
            if entity in IMMUTABLE_BLOCK_ENTITIES and value > 0.65:
                raise ValueError(
                    f"{entity} threshold cannot exceed 0.65 for fail-closed policy"
                )
        self.thresholds: Mapping[str, float] = MappingProxyType(
            normalized_thresholds
        )

    def resolve(self, spans: list[Span]) -> list[Decision]:
        eligible = [
            span
            for span in spans
            if span.entity_type in IMMUTABLE_BLOCK_ENTITIES
            or span.validated
            or span.confidence >= self.thresholds.get(span.entity_type, 0.65)
        ]
        fused = fuse_spans(eligible, self.actions)
        return [
            Decision(
                span=span,
                action=self.actions.get(span.entity_type, Action.BLOCK),
                reason=self._reason(span),
            )
            for span in fused
        ]

    def _reason(self, span: Span) -> str:
        action = self.actions.get(span.entity_type, Action.BLOCK)
        if action is Action.BLOCK:
            return f"{span.entity_type} is prohibited from external-model input"
        if action is Action.TOKENIZE:
            return f"{span.entity_type} requires reversible local pseudonymization"
        if action is Action.REMOVE:
            return f"{span.entity_type} requires irreversible removal"
        return f"{span.entity_type} is permitted by policy {self.version}"


def fuse_spans(
    spans: Iterable[Span],
    actions: Mapping[str, Action] | None = None,
) -> list[Span]:
    action_map = {**DEFAULT_ACTIONS, **(actions or {})}
    deduplicated: dict[tuple[str, int, int, str, str], Span] = {}
    for span in spans:
        key = (
            span.source,
            span.start,
            span.end,
            span.entity_type,
            span.detector,
        )
        previous = deduplicated.get(key)
        if previous is None or _rank(span, action_map) > _rank(previous, action_map):
            deduplicated[key] = span

    ordered = sorted(
        deduplicated.values(),
        key=lambda item: (item.source, item.start, item.end),
    )
    output: list[Span] = []
    group: list[Span] = []
    group_source: str | None = None
    group_end = -1

    def flush() -> None:
        nonlocal group
        if not group:
            return
        winner = max(group, key=lambda item: _rank(item, action_map))
        merged = replace(
            winner,
            start=min(item.start for item in group),
            end=max(item.end for item in group),
            metadata={
                **winner.metadata,
                "detector_chain": sorted({item.detector for item in group}),
                "merged_span_count": len(group),
            },
        )
        output.append(merged)
        group = []

    for span in ordered:
        if group and (span.source != group_source or span.start >= group_end):
            flush()
            group_source = None
            group_end = -1
        if not group:
            group_source = span.source
            group_end = span.end
        else:
            group_end = max(group_end, span.end)
        group.append(span)
    flush()
    return sorted(output, key=lambda item: (item.source, item.start, item.end))


def _rank(
    span: Span,
    actions: Mapping[str, Action],
) -> tuple[int, int, int, int, int, float, int, int]:
    action_rank = {
        Action.ALLOW: 0,
        Action.TOKENIZE: 1,
        Action.REMOVE: 2,
        Action.BLOCK: 3,
    }
    detector_rank = {
        "privacy_filter": 1,
        "rule": 2,
        "known_value": 3,
    }
    return (
        action_rank[actions.get(span.entity_type, Action.BLOCK)],
        int(span.severity == Severity.CRITICAL),
        int(span.detector != "edge_ml"),
        1 if span.validated else 0,
        int(span.severity),
        # The compact edge model is a fallback contextual signal; do not let
        # it replace a deterministic span at the same range. Other model
        # detectors still participate by confidence as before.
        span.confidence,
        detector_rank.get(span.detector, 0),
        span.length,
    )
