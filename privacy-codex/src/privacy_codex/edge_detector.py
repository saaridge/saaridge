"""Small, local, non-generative detector for edge deployments.

The model is an averaged sparse perceptron over BIO token labels.  It is
intentionally boring: training happens offline, the edge runtime loads one
JSON bundle, and inference uses only Python's standard library.  Patterns and
the policy remain separate from the learned model.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from .errors import DetectorExecutionError, DetectorUnavailableError
from .models import DetectionContext, Severity, Span

_TOKEN_RE = re.compile(r"\w+(?:['’_-]\w+)*|[^\w\s]", re.UNICODE)
_FIELD_RE = re.compile(r"(?:^|[|\s])([A-Za-z][A-Za-z0-9_. -]{0,48})\s*(?:=|:)")
_MODEL_FORMAT = "privacy-codex-edge-perceptron-v1"


@dataclass(frozen=True)
class Token:
    text: str
    start: int
    end: int


def _tokens(text: str) -> list[Token]:
    return [Token(m.group(0), m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]


def _shape(value: str) -> str:
    value = re.sub(r"[A-Z]", "A", value)
    value = re.sub(r"[a-z]", "a", value)
    value = re.sub(r"\d", "0", value)
    return value[:32]


def _field_context(text: str, start: int) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    prefix = text[line_start:start]
    matches = list(_FIELD_RE.finditer(prefix))
    if not matches:
        return ""
    return re.sub(r"\s+", "_", matches[-1].group(1).strip().lower())[:48]


def _field_contexts(text: str, token_list: Sequence[Token]) -> list[str]:
    """Compute field context in one pass; avoid quadratic prefix rescans."""
    contexts: list[str] = []
    line_start = 0
    line_end = text.find("\n", line_start)
    if line_end < 0:
        line_end = len(text)
    matches = list(_FIELD_RE.finditer(text[line_start:line_end]))
    match_index = 0
    current = ""
    for token in token_list:
        while token.start >= line_end and line_end < len(text):
            line_start = line_end + 1
            line_end = text.find("\n", line_start)
            if line_end < 0:
                line_end = len(text)
            matches = list(_FIELD_RE.finditer(text[line_start:line_end]))
            match_index = 0
            current = ""
        while match_index < len(matches) and line_start + matches[match_index].end() <= token.start:
            current = re.sub(
                r"\s+", "_", matches[match_index].group(1).strip().lower()
            )[:48]
            match_index += 1
        contexts.append(current)
    return contexts


def _features(
    text: str,
    token_list: Sequence[Token],
    index: int,
    field_context: str | None = None,
) -> list[str]:
    token = token_list[index]
    value = token.text
    lower = value.casefold()
    previous = token_list[index - 1].text.casefold() if index else "<bos>"
    following = (
        token_list[index + 1].text.casefold()
        if index + 1 < len(token_list)
        else "<eos>"
    )
    features = [
        "bias",
        f"shape={_shape(value)}",
        f"len={min(len(value), 24)}",
        f"prefix={lower[:3]}",
        f"suffix={lower[-3:]}",
        f"prev={previous[:32]}",
        f"next={following[:32]}",
        f"prev_shape={_shape(previous)}",
        f"next_shape={_shape(following)}",
        f"field={field_context if field_context is not None else _field_context(text, token.start)}",
        f"has_digit={int(any(ch.isdigit() for ch in value))}",
        f"is_title={int(value[:1].isupper() and value[1:].islower())}",
        f"is_upper={int(value.isupper())}",
        f"is_lower={int(value.islower())}",
    ]
    for size in (2, 3, 4):
        if len(lower) >= size:
            features.extend(f"ngram={lower[pos:pos + size]}" for pos in range(len(lower) - size + 1))
    return features


def _gold_labels(text: str, tokens: Sequence[Token], spans: Sequence[dict[str, Any]]) -> list[str]:
    labels = ["O"] * len(tokens)
    ordered = sorted(
        (span for span in spans if str(span.get("action", "TOKENIZE")).upper() != "ALLOW"),
        key=lambda span: (int(span["start"]), int(span["end"])),
    )
    for span in ordered:
        start = int(span["start"])
        end = int(span["end"])
        label = str(span["type"]).upper()
        covered = [i for i, token in enumerate(tokens) if token.start < end and token.end > start]
        for offset, index in enumerate(covered):
            labels[index] = f"B-{label}" if offset == 0 else f"I-{label}"
    return labels


class EdgePerceptronModel:
    """A compact averaged perceptron model with generic token features."""

    def __init__(self, labels: Sequence[str], weights: dict[str, dict[str, float]]) -> None:
        normalized = tuple(dict.fromkeys(str(label) for label in labels))
        if "O" not in normalized:
            normalized = ("O", *normalized)
        if not normalized:
            raise ValueError("edge model must contain at least one label")
        self.labels = normalized
        self.weights = {
            str(feature): {str(label): float(value) for label, value in values.items()}
            for feature, values in weights.items()
        }

    def scores(self, features: Sequence[str]) -> dict[str, float]:
        scores = {label: 0.0 for label in self.labels}
        for feature in features:
            for label, value in self.weights.get(feature, {}).items():
                if label in scores:
                    scores[label] += value
        return scores

    def predict(self, text: str, *, threshold: float = 0.80) -> list[tuple[int, int, str, float]]:
        token_list = _tokens(text)
        if not token_list:
            return []
        field_contexts = _field_contexts(text, token_list)
        candidate_indices: set[int] = set()
        for index, token in enumerate(token_list):
            value = token.text
            field = field_contexts[index]
            candidate = bool(field) or any(
                character.isupper() or character.isdigit() for character in value
            )
            if candidate:
                candidate_indices.update(
                    range(max(0, index - 3), min(len(token_list), index + 4))
                )
        if not candidate_indices:
            return []
        token_predictions: list[tuple[str, float]] = []
        for index in range(len(token_list)):
            if index not in candidate_indices:
                token_predictions.append(("O", 1.0))
                continue
            scores = self.scores(
                _features(text, token_list, index, field_contexts[index])
            )
            ranked = sorted(scores.items(), key=lambda item: (item[1], item[0]), reverse=True)
            best_label, best_score = ranked[0]
            second_score = ranked[1][1] if len(ranked) > 1 else 0.0
            margin = best_score - second_score
            confidence = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, margin))))
            if best_label == "O" or confidence < threshold:
                token_predictions.append(("O", confidence))
            else:
                token_predictions.append((best_label, confidence))

        spans: list[tuple[int, int, str, float]] = []
        active_start: int | None = None
        active_end = 0
        active_type: str | None = None
        confidences: list[float] = []

        def flush() -> None:
            nonlocal active_start, active_end, active_type, confidences
            if active_start is not None and active_type is not None:
                spans.append(
                    (
                        active_start,
                        active_end,
                        active_type,
                        sum(confidences) / len(confidences),
                    )
                )
            active_start = None
            active_end = 0
            active_type = None
            confidences = []

        for index, (label, confidence) in enumerate(token_predictions):
            if label == "O":
                flush()
                continue
            prefix, _, entity = label.partition("-")
            if prefix == "B" or entity != active_type:
                flush()
                active_start = token_list[index].start
                active_type = entity
            active_end = token_list[index].end
            confidences.append(confidence)
        flush()
        return spans

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": _MODEL_FORMAT,
            "labels": list(self.labels),
            "weights": self.weights,
            "feature_schema": "shape-prefix-suffix-context-v1",
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> EdgePerceptronModel:
        if payload.get("format") != _MODEL_FORMAT:
            raise ValueError("unsupported edge detector model format")
        labels = payload.get("labels")
        weights = payload.get("weights")
        if not isinstance(labels, list) or not isinstance(weights, dict):
            raise ValueError("edge detector bundle is malformed")
        return cls(labels, weights)


def train_edge_model(
    records: Iterable[dict[str, Any]],
    *,
    epochs: int = 8,
    learning_rate: float = 1.0,
) -> EdgePerceptronModel:
    """Train an edge model from records containing ``text`` and ``spans``."""
    examples: list[tuple[str, list[Token], list[str]]] = []
    labels: set[str] = {"O"}
    for record in records:
        text = record.get("text")
        spans = record.get("spans", [])
        if not isinstance(text, str) or not isinstance(spans, list):
            raise ValueError("training records require text and spans")
        token_list = _tokens(text)
        gold = _gold_labels(text, token_list, spans)
        labels.update(gold)
        examples.append((text, token_list, gold))
    if not examples:
        raise ValueError("no training examples supplied")
    ordered_labels = ("O", *sorted(label for label in labels if label != "O"))
    weights: dict[tuple[str, str], float] = {}
    totals: dict[tuple[str, str], float] = {}
    timestamps: dict[tuple[str, str], int] = {}
    step = 0

    def touch(key: tuple[str, str]) -> None:
        previous = timestamps.get(key, 0)
        totals[key] = totals.get(key, 0.0) + (step - previous) * weights.get(key, 0.0)
        timestamps[key] = step

    def adjust(feature: str, label: str, delta: float) -> None:
        key = (feature, label)
        touch(key)
        weights[key] = weights.get(key, 0.0) + delta

    for _ in range(max(1, epochs)):
        for text, token_list, gold in examples:
            field_contexts = _field_contexts(text, token_list)
            for index, expected in enumerate(gold):
                step += 1
                features = _features(
                    text, token_list, index, field_contexts[index]
                )
                score_by_label = {
                    label: sum(weights.get((feature, label), 0.0) for feature in features)
                    for label in ordered_labels
                }
                predicted = max(ordered_labels, key=lambda label: (score_by_label[label], label))
                if predicted != expected:
                    for feature in features:
                        adjust(feature, expected, learning_rate)
                        adjust(feature, predicted, -learning_rate)
    averaged: dict[str, dict[str, float]] = {}
    for key in set(weights) | set(totals):
        touch(key)
        value = totals.get(key, 0.0) / max(1, step)
        if abs(value) > 1e-9:
            averaged.setdefault(key[0], {})[key[1]] = round(value, 6)
    return EdgePerceptronModel(ordered_labels, averaged)


def save_edge_model(model: EdgePerceptronModel, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(model.to_dict(), sort_keys=True, separators=(",", ":")) + "\n"
    path.write_text(payload, encoding="utf-8")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_edge_training_records(
    dataset_path: Path,
    *,
    split: str | None = "dev",
) -> list[dict[str, Any]]:
    """Load query/document records from the package's JSONL evaluation format."""
    records: list[dict[str, Any]] = []
    with dataset_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid training JSONL at line {line_number}") from error
            if split is not None and case.get("split", "test") != split:
                continue
            for source_name in ("query", "document"):
                text = case.get(source_name)
                if not isinstance(text, str):
                    continue
                spans = [
                    span
                    for span in case.get("gold_spans", [])
                    if isinstance(span, dict) and span.get("source") == source_name
                ]
                records.append({"text": text, "spans": spans, "source": source_name})
    if not records:
        raise ValueError("training dataset contains no records for the requested split")
    return records


def train_edge_model_from_jsonl(
    dataset_path: Path,
    output_path: Path,
    *,
    split: str | None = "dev",
    epochs: int = 8,
) -> str:
    records = load_edge_training_records(dataset_path, split=split)
    model = train_edge_model(records, epochs=epochs)
    return save_edge_model(model, output_path)


def load_edge_model(path: Path, *, expected_digest: str | None = None) -> EdgePerceptronModel:
    if not path.is_file():
        raise DetectorUnavailableError("edge detector model file is unavailable")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected_digest and digest.casefold() != expected_digest.strip().casefold():
        raise DetectorUnavailableError("edge detector model digest does not match")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return EdgePerceptronModel.from_dict(payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise DetectorUnavailableError("edge detector model is malformed") from error


class EdgeMLDetector:
    """Detector adapter for the compact local model."""

    name = "edge_ml"
    version = _MODEL_FORMAT

    def __init__(
        self,
        model_path: Path | None = None,
        *,
        model: EdgePerceptronModel | None = None,
        required: bool = True,
        expected_digest: str | None = None,
        threshold: float = 0.80,
    ) -> None:
        if model is None and model_path is None:
            raise ValueError("edge detector requires model_path or model")
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("edge detector threshold must be between 0 and 1")
        self.required = required
        self.model_path = model_path
        self._model = model
        self._expected_digest = expected_digest
        self.threshold = threshold
        self.model_digest: str | None = "injected" if model is not None else None

    def detect(self, text: str, context: DetectionContext) -> list[Span]:
        try:
            if self._model is None:
                if self.model_path is None:
                    raise DetectorUnavailableError("edge detector model is not configured")
                if self.required and not self._expected_digest:
                    raise DetectorUnavailableError(
                        "required edge detector must be pinned by SHA-256 digest"
                    )
                self._model = load_edge_model(
                    self.model_path,
                    expected_digest=self._expected_digest,
                )
                self.model_digest = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
            predictions = self._model.predict(text, threshold=self.threshold)
            from .detectors import _severity_for

            return [
                Span(
                    source=context.source,
                    start=start,
                    end=end,
                    entity_type=entity,
                    confidence=max(0.0, min(confidence, 1.0)),
                    detector=self.name,
                    severity=_severity_for(entity),
                    validated=False,
                    metadata={"model_format": _MODEL_FORMAT, "model_digest": self.model_digest},
                )
                for start, end, entity, confidence in predictions
            ]
        except DetectorUnavailableError:
            raise
        except Exception as error:
            raise DetectorExecutionError("edge detector inference failed") from error
