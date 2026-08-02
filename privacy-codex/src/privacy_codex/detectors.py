from __future__ import annotations

import hashlib
import hmac
import ipaddress
import math
import multiprocessing
import os
import re
import signal
import threading
import time
from multiprocessing.connection import Connection, wait as wait_connections
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol, cast

from .errors import DetectorExecutionError, DetectorUnavailableError
from .models import (
    CRITICAL_ENTITY_TYPES,
    DetectionContext,
    Severity,
    Span,
    TextSource,
)

PAYMENT_CARD_CANDIDATE = re.compile(
    r"(?<![A-Za-z0-9])\d"
    r"(?:(?:[^\S\r\n]|[./_-]){0,3}\d){12,18}"
    r"(?![A-Za-z0-9])"
)


class Detector(Protocol):
    name: str
    required: bool

    def detect(self, text: str, context: DetectionContext) -> list[Span]: ...


class KnownValueDetector:
    name = "known_value"
    required = True

    def detect(self, text: str, context: DetectionContext) -> list[Span]:
        spans: list[Span] = []
        for entity_type, values in context.known_values.items():
            normalized_type = entity_type.upper()
            for value in values:
                if not value:
                    continue
                for start, end in _find_known_occurrences(
                    text, value, identifier=_is_identifier_type(normalized_type)
                ):
                    spans.append(
                        Span(
                            source=context.source,
                            start=start,
                            end=end,
                            entity_type=normalized_type,
                            confidence=1.0,
                            detector=self.name,
                            severity=_severity_for(normalized_type),
                            validated=True,
                            metadata={"known_value": True},
                        )
                    )
        return _deduplicate(spans)


class RuleDetector:
    name = "rule"
    required = True

    _email = re.compile(
        r"(?<![\w.+-])[A-Z0-9.!#$%&'*+/?^_`{|}~-]+@"
        r"(?:[A-Z0-9-]+\.)+[A-Z]{2,63}(?![\w-])",
        re.IGNORECASE,
    )
    _obfuscated_email = re.compile(
        r"(?<![\w.+-])[A-Z0-9._%+-]+"
        r"\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*"
        r"[A-Z0-9.-]+\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\))\s*"
        r"[A-Z]{2,63}(?![\w-])",
        re.IGNORECASE,
    )
    _phone_candidate = re.compile(
        r"(?<!\w)(?:\+\d{1,3}[\s().-]?)?"
        r"(?:\(?\d{1,4}\)?[\s.-]?){2,6}\d{1,4}(?!\w)"
    )
    _ipv4_candidate = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
    _ipv6_candidate = re.compile(
        r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}"
        r"(?![0-9A-Fa-f:])"
    )
    _jwt = re.compile(
        r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\."
        r"[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"
    )
    _openai_key = re.compile(
        r"(?<![A-Za-z0-9])(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])"
    )
    _github_token = re.compile(
        r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,255}|"
        r"github_pat_[A-Za-z0-9_]{20,255})(?![A-Za-z0-9_])"
    )
    _aws_key = re.compile(
        r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])"
    )
    _vendor_key = re.compile(
        r"(?<![A-Za-z0-9_-])(?:"
        r"AIza[0-9A-Za-z_-]{35}|"
        r"glpat-[A-Za-z0-9_-]{20,}|"
        r"xox[baprs]-[A-Za-z0-9-]{10,}|"
        r"sk_(?:live|test)_[A-Za-z0-9]{16,}"
        r")(?![A-Za-z0-9_-])"
    )
    _bearer_token = re.compile(
        r"(?i)\bBearer\s+(?P<value>[A-Za-z0-9._~+/=-]{12,})"
    )
    _database_url = re.compile(
        r"(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|"
        r"redis|rediss|mssql)://[^:/\s@]+:[^@\s/]+@[^\s\"'<>]+"
    )
    _named_secret = re.compile(
        r"(?i)(?<!\w)[\"']?"
        r"(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)"
        r"[\"']?\s*(?:=|:|\|)\s*[\"']?"
        r"(?P<value>[A-Za-z0-9+/_.=-]{8,})[\"']?"
    )
    _password = re.compile(
        r"(?i)(?<![\w-])[\"']?"
        r"(?:[A-Za-z][A-Za-z0-9]{0,31}[_-])?(?:password|passwd|pwd)[\"']?"
        r"\s*(?:=|:|\||\bis\b)\s*"
        r"(?P<value>\"[^\"\r\n]{4,}\"|'[^'\r\n]{4,}'|[^\s,;}\]]{4,})"
    )
    _cli_password = re.compile(
        r"(?i)(?<!\w)(?:--password|--passwd|--pwd)"
        r"(?:\s*=\s*|\s+)"
        r"(?P<value>\"[^\"\r\n]{4,}\"|'[^'\r\n]{4,}'|[^\s,;}\]]{4,})"
    )
    _private_key = re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"
        r"[\s\S]{16,}?-----END "
        r"(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"
    )
    _cvv = re.compile(
        r"(?i)(?<!\w)[\"']?(?:cvv2?|cvc2?|card[_ -]?security[_ -]?code)[\"']?"
        r"\s*(?:=|:|\|)\s*[\"']?(?P<value>\d{3,4})\b"
    )
    _booking = re.compile(
        r"(?i)(?<!\w)[\"']?(?:booking|reservation|itinerary)"
        r"(?:[_ -]?(?:id|number|no\.?|reference|ref))?[\"']?"
        r"\s*(?:=|:|#|\||-)\s*[\"']?"
        r"(?P<value>(?=[A-Z0-9-]{6,20}\b)(?=[A-Z0-9-]*\d)"
        r"[A-Z0-9][A-Z0-9-]{5,19})\b"
    )
    _loyalty = re.compile(
        r"(?i)(?<!\w)[\"']?(?:loyalty|rewards?|membership)"
        r"(?:[_ -]?(?:id|number|no\.?|account))?[\"']?"
        r"\s*(?:=|:|#|\||-)\s*[\"']?"
        r"(?P<value>(?=[A-Z0-9-]{6,24}\b)(?=[A-Z0-9-]*\d)"
        r"[A-Z0-9][A-Z0-9-]{5,23})\b"
    )
    _account = re.compile(
        r"(?i)(?<!\w)[\"']?(?:account|customer)"
        r"[_ -]?(?:id|number|no\.?)[\"']?"
        r"\s*(?:=|:|#|\||-)\s*[\"']?"
        r"(?P<value>(?=[A-Z0-9-]{6,24}\b)(?=[A-Z0-9-]*\d)"
        r"[A-Z0-9][A-Z0-9-]{5,23})\b"
    )
    _passport = re.compile(
        r"(?i)(?<!\w)[\"']?passport"
        r"(?:[_ -]?(?:id|number|no\.?))?[\"']?"
        r"\s*(?:=|:|#|\||-)\s*[\"']?"
        r"(?P<value>(?=[A-Z0-9-]{6,15}\b)(?=[A-Z0-9-]*\d)"
        r"[A-Z0-9][A-Z0-9-]{5,14})\b"
    )
    _person = re.compile(
        r"(?i)(?<!\w)[\"']?"
        r"(?:guest(?:[_ -]?name)?|passenger[_ -]?name|customer[_ -]?name|"
        r"traveler[_ -]?name|traveller[_ -]?name|full[_ -]?name)[\"']?"
        r"\s*(?:=|:|\||-|—|–)\s*[\"']?"
        r"(?P<value>[^\W\d_](?:[^\W\d_]|['’\-]){1,30}"
        r"(?:[ \t]+(?!(?:is|was|has|had|will|checked|booked|requested|"
        r"cancelled|canceled|confirmed|pending|arrived|departed|contacted|"
        r"stayed|with|from|for|at)\b)"
        r"[^\W\d_](?:[^\W\d_]|['’\-]){1,30}){1,3})"
    )
    _address = re.compile(
        r"(?i)(?<!\w)[\"']?(?:home|residential|private|guest)[_ -]+address[\"']?"
        r"\s*(?:=|:|\||-|—|–)\s*[\"']?"
        r"(?P<value>\d{1,6}\s+[A-Za-z0-9.'’ -]{2,70}"
        r"\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|"
        r"boulevard|blvd\.?|way|court|ct\.?)(?:[ \t,]+[A-Za-z0-9.'’ -]{2,40})?)"
    )
    _private_date = re.compile(
        r"(?i)(?<!\w)[\"']?"
        r"(?:date[_ -]+of[_ -]+birth|birth[_ -]+date|dob)[\"']?"
        r"\s*(?:=|:|\||-|—|–)\s*[\"']?"
        r"(?P<value>(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|"
        r"(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4})|"
        r"(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
        r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
        r"Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}))\b"
    )

    def detect(self, text: str, context: DetectionContext) -> list[Span]:
        spans: list[Span] = []
        spans.extend(
            self._matches(text, context, self._email, "EMAIL", Severity.HIGH, 0.995)
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._obfuscated_email,
                "EMAIL",
                Severity.HIGH,
                0.98,
            )
        )
        spans.extend(self._phones(text, context))
        spans.extend(self._ips(text, context))
        spans.extend(self._cards(text, context))
        spans.extend(
            self._matches(
                text, context, self._jwt, "CREDENTIAL", Severity.CRITICAL, 0.999
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._openai_key,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.999,
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._github_token,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.999,
            )
        )
        spans.extend(
            self._matches(
                text, context, self._aws_key, "CREDENTIAL", Severity.CRITICAL, 0.999
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._vendor_key,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.999,
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._database_url,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.999,
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._bearer_token,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.999,
                group="value",
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._named_secret,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.995,
                group="value",
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._password,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.995,
                group="value",
                trim="\"'.",
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._cli_password,
                "CREDENTIAL",
                Severity.CRITICAL,
                0.995,
                group="value",
                trim="\"'.",
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._private_key,
                "PRIVATE_KEY",
                Severity.CRITICAL,
                1.0,
            )
        )
        spans.extend(
            self._matches(
                text,
                context,
                self._cvv,
                "CVV",
                Severity.CRITICAL,
                1.0,
                group="value",
            )
        )
        contextual = (
            (self._booking, "BOOKING_ID", Severity.HIGH, 0.99),
            (self._loyalty, "LOYALTY_ID", Severity.HIGH, 0.99),
            (self._account, "ACCOUNT_ID", Severity.HIGH, 0.99),
            (self._passport, "PASSPORT_ID", Severity.HIGH, 0.99),
            (self._person, "PERSON", Severity.HIGH, 0.92),
            (self._address, "PRIVATE_ADDRESS", Severity.HIGH, 0.94),
            (self._private_date, "DATE", Severity.MEDIUM, 0.96),
        )
        for pattern, entity, severity, confidence in contextual:
            spans.extend(
                self._matches(
                    text,
                    context,
                    pattern,
                    entity,
                    severity,
                    confidence,
                    group="value",
                    trim=" \t." if entity == "PRIVATE_ADDRESS" else None,
                    validated=entity
                    not in {"PERSON", "PRIVATE_ADDRESS", "DATE"},
                )
            )
        return _deduplicate(spans)

    def _matches(
        self,
        text: str,
        context: DetectionContext,
        pattern: re.Pattern[str],
        entity_type: str,
        severity: Severity,
        confidence: float,
        *,
        group: int | str = 0,
        trim: str | None = None,
        validated: bool = True,
    ) -> list[Span]:
        spans: list[Span] = []
        for match in pattern.finditer(text):
            start = match.start(group)
            end = match.end(group)
            if start < 0 or end <= start:
                continue
            if trim:
                while start < end and text[start] in trim:
                    start += 1
                while end > start and text[end - 1] in trim:
                    end -= 1
            if end <= start:
                continue
            spans.append(
                Span(
                    source=context.source,
                    start=start,
                    end=end,
                    entity_type=entity_type,
                    confidence=confidence,
                    detector=self.name,
                    severity=severity,
                    validated=validated,
                )
            )
        return spans

    def _phones(self, text: str, context: DetectionContext) -> list[Span]:
        spans: list[Span] = []
        for match in self._phone_candidate.finditer(text):
            candidate = match.group(0).strip()
            start = match.start() + (len(match.group(0)) - len(match.group(0).lstrip()))
            digits = re.sub(r"\D", "", candidate)
            has_formatting = bool(
                candidate.startswith("+") or re.search(r"[\s().-]", candidate)
            )
            if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", candidate):
                continue
            nearby = text[max(0, start - 18) : start].casefold()
            has_context = any(
                word in nearby for word in ("phone", "mobile", "tel", "contact")
            )
            if not 7 <= len(digits) <= 15 or not (has_formatting or has_context):
                continue
            if (
                len(digits) < 10
                and not candidate.startswith("+")
                and not has_context
            ):
                continue
            if (
                candidate.count(".") >= 3
                and not candidate.startswith("+")
                and not has_context
            ):
                continue
            if re.fullmatch(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", candidate):
                continue
            spans.append(
                Span(
                    source=context.source,
                    start=start,
                    end=start + len(candidate),
                    entity_type="PHONE",
                    confidence=0.97 if candidate.startswith("+") else 0.9,
                    detector=self.name,
                    severity=Severity.HIGH,
                    validated=True,
                )
            )
        return spans

    def _ips(self, text: str, context: DetectionContext) -> list[Span]:
        spans: list[Span] = []
        seen: set[tuple[int, int]] = set()
        for pattern in (self._ipv4_candidate, self._ipv6_candidate):
            for match in pattern.finditer(text):
                candidate = match.group(0)
                if not candidate or candidate == ":":
                    continue
                try:
                    ipaddress.ip_address(candidate)
                except ValueError:
                    continue
                offsets = (match.start(), match.end())
                if offsets in seen:
                    continue
                seen.add(offsets)
                spans.append(
                    Span(
                        source=context.source,
                        start=match.start(),
                        end=match.end(),
                        entity_type="IP_ADDRESS",
                        confidence=0.995,
                        detector=self.name,
                        severity=Severity.MEDIUM,
                        validated=True,
                    )
                )
        return spans

    def _cards(self, text: str, context: DetectionContext) -> list[Span]:
        spans: list[Span] = []
        for match in iter_valid_payment_card_candidates(text):
            candidate = match.group(0)
            spans.append(
                Span(
                    source=context.source,
                    start=match.start(),
                    end=match.start() + len(candidate),
                    entity_type="PAYMENT_CARD",
                    confidence=1.0,
                    detector=self.name,
                    severity=Severity.CRITICAL,
                    validated=True,
                    metadata={"validator": "luhn"},
                )
            )
        return spans


class DetectSecretsDetector:
    """Optional in-memory adapter for Yelp's detect-secrets plugin suite.

    The adapter never writes source text to a temporary file. RuleDetector
    remains the required deterministic layer; this adapter adds breadth when
    the optional ``detectors`` dependency group is installed.
    """

    name = "detect_secrets"

    def __init__(self, *, required: bool = False) -> None:
        self.required = required

    def detect(self, text: str, context: DetectionContext) -> list[Span]:
        try:
            from detect_secrets.core.scan import scan_line
            from detect_secrets.settings import default_settings
        except ImportError as error:
            raise DetectorUnavailableError(
                "detect-secrets is not installed"
            ) from error

        spans: list[Span] = []
        offset = 0
        try:
            with default_settings():
                for line in text.splitlines(keepends=True):
                    for finding in scan_line(line):
                        secret = getattr(finding, "secret_value", None)
                        if not isinstance(secret, str) or len(secret) < 4:
                            continue
                        plugin_name = str(
                            getattr(finding, "type", "detect-secrets")
                        )
                        for match in re.finditer(re.escape(secret), line):
                            spans.append(
                                Span(
                                    source=context.source,
                                    start=offset + match.start(),
                                    end=offset + match.end(),
                                    entity_type="CREDENTIAL",
                                    confidence=0.99,
                                    detector=self.name,
                                    severity=Severity.CRITICAL,
                                    validated=True,
                                    metadata={"plugin": plugin_name},
                                )
                            )
                    offset += len(line)
        except Exception as error:
            raise DetectorExecutionError(
                "detect-secrets failed while scanning in memory"
            ) from error
        return _deduplicate(spans)


InferenceFunction = Callable[[str], list[dict[str, Any]]]
_DETECTOR_WORKER_GRACE_SECONDS = 0.25
_DETECTOR_WORKER_PROTOCOL = 1


class PrivacyFilterDetector:
    name = "privacy_filter"

    LABEL_MAP = {
        "PERSON": "PERSON",
        "PRIVATE_PERSON": "PERSON",
        "ADDRESS": "PRIVATE_ADDRESS",
        "PRIVATE_ADDRESS": "PRIVATE_ADDRESS",
        "EMAIL": "EMAIL",
        "PHONE": "PHONE",
        "DATE": "DATE",
        "PRIVATE_DATE": "DATE",
        "ACCOUNT": "ACCOUNT_ID",
        "ACCOUNT_NUMBER": "ACCOUNT_ID",
        "SECRET": "CREDENTIAL",
        "CREDENTIAL": "CREDENTIAL",
    }

    def __init__(
        self,
        model_path: Path | None = None,
        *,
        required: bool = True,
        inference: InferenceFunction | None = None,
        expected_digest: str | None = None,
        inference_window_characters: int = 1_600,
        inference_window_overlap: int = 200,
    ) -> None:
        if inference_window_characters < 256:
            raise ValueError("classifier inference windows must be at least 256 characters")
        if not 0 <= inference_window_overlap < inference_window_characters:
            raise ValueError("classifier overlap must be smaller than its window")
        self.required = required
        self._model_path = model_path
        self._inference = inference
        self._expected_digest = expected_digest
        self._inference_window_characters = inference_window_characters
        self._inference_window_overlap = inference_window_overlap
        self._pipeline: Any | None = None
        self._pipeline_stride = 0
        self._inference_lock = threading.Lock()
        self._cached_model_digest: str | None = (
            "injected" if inference is not None else None
        )

    def detect(self, text: str, context: DetectionContext) -> list[Span]:
        try:
            predictions = self._infer(text)
        except Exception as error:
            if isinstance(error, DetectorUnavailableError):
                raise
            raise DetectorExecutionError(
                "the local privacy classifier failed"
            ) from error

        spans: list[Span] = []
        for prediction in predictions:
            raw_label = str(
                prediction.get("entity_group")
                or prediction.get("entity")
                or prediction.get("label")
                or ""
            ).upper()
            raw_label = raw_label.removeprefix("B-").removeprefix("I-")
            entity = self.LABEL_MAP.get(raw_label)
            if entity is None:
                if raw_label in {"O", "OTHER", "PUBLIC"}:
                    continue
                entity = "UNKNOWN_HIGH_RISK"
            start = int(prediction.get("start", -1))
            end = int(prediction.get("end", -1))
            score = float(prediction.get("score", 0.0))
            if not math.isfinite(score):
                raise DetectorExecutionError(
                    "the local privacy classifier returned a non-finite score"
                )
            if start < 0 or end <= start or end > len(text):
                continue
            private = bool(prediction.get("private", True))
            if entity == "DATE" and not private:
                continue
            spans.append(
                Span(
                    source=context.source,
                    start=start,
                    end=end,
                    entity_type=entity,
                    confidence=max(0.0, min(score, 1.0)),
                    detector=self.name,
                    severity=_severity_for(entity),
                    validated=False,
                    private=private,
                    metadata={
                        "model_label": raw_label,
                        "model_digest": self.model_digest,
                    },
                )
            )
        return _deduplicate(spans)

    @property
    def model_digest(self) -> str | None:
        return self._cached_model_digest

    def _infer(self, text: str) -> list[dict[str, Any]]:
        if self._inference is not None:
            return self._infer_injected_windows(text)
        if self._model_path is None:
            raise DetectorUnavailableError(
                "the required local privacy classifier is not configured"
            )
        if not self._model_path.is_absolute() or not self._model_path.is_dir():
            raise DetectorUnavailableError(
                "the privacy classifier path must be an existing absolute directory"
            )
        if self.required and not self._expected_digest:
            raise DetectorUnavailableError(
                "the required local privacy classifier must be pinned by digest"
            )
        if self._cached_model_digest is None:
            self._cached_model_digest = directory_digest(self._model_path)
        digest = self._cached_model_digest
        if self._expected_digest and not hmac.compare_digest(
            digest.casefold(), self._expected_digest.strip().casefold()
        ):
            raise DetectorUnavailableError("the local model digest does not match")
        with self._inference_lock:
            if self._pipeline is None:
                try:
                    from transformers import (
                        AutoModelForTokenClassification,
                        AutoTokenizer,
                        pipeline,
                    )
                except ImportError as error:
                    raise DetectorUnavailableError(
                        "local classifier dependencies are not installed"
                    ) from error
                tokenizer = AutoTokenizer.from_pretrained(
                    str(self._model_path),
                    local_files_only=True,
                    trust_remote_code=False,
                )
                if not bool(getattr(tokenizer, "is_fast", False)):
                    raise DetectorUnavailableError(
                        "the local classifier requires a fast tokenizer for exact offsets"
                    )
                model = AutoModelForTokenClassification.from_pretrained(
                    str(self._model_path),
                    local_files_only=True,
                    trust_remote_code=False,
                )
                self._pipeline = pipeline(
                    "token-classification",
                    model=model,
                    tokenizer=tokenizer,
                    aggregation_strategy="simple",
                    device=-1,
                )
                model_max_length = int(
                    getattr(tokenizer, "model_max_length", 512)
                )
                if model_max_length <= 0 or model_max_length > 100_000:
                    model_max_length = 512
                special_tokens = int(tokenizer.num_special_tokens_to_add())
                usable_tokens = max(1, model_max_length - special_tokens)
                self._pipeline_stride = min(128, max(0, usable_tokens // 4))
            if self._pipeline_stride:
                output = self._pipeline(text, stride=self._pipeline_stride)
            else:
                output = self._pipeline(text)
        if not isinstance(output, list):
            raise DetectorExecutionError("the local classifier returned invalid output")
        return [dict(item) for item in output]

    def _infer_injected_windows(self, text: str) -> list[dict[str, Any]]:
        if self._inference is None:
            return []
        if not text:
            return []
        output: list[dict[str, Any]] = []
        start = 0
        while start < len(text):
            end = min(len(text), start + self._inference_window_characters)
            with self._inference_lock:
                predictions = self._inference(text[start:end])
            if not isinstance(predictions, list):
                raise DetectorExecutionError(
                    "the injected classifier returned invalid output"
                )
            for raw_prediction in predictions:
                if not isinstance(raw_prediction, dict):
                    raise DetectorExecutionError(
                        "the injected classifier returned an invalid prediction"
                    )
                prediction = dict(raw_prediction)
                local_start = prediction.get("start")
                local_end = prediction.get("end")
                if (
                    not isinstance(local_start, int)
                    or isinstance(local_start, bool)
                    or not isinstance(local_end, int)
                    or isinstance(local_end, bool)
                    or local_start < 0
                    or local_end <= local_start
                    or local_end > end - start
                ):
                    raise DetectorExecutionError(
                        "the injected classifier returned invalid offsets"
                    )
                prediction["start"] = start + local_start
                prediction["end"] = start + local_end
                output.append(prediction)
            if end == len(text):
                break
            start = end - self._inference_window_overlap
        return output


class _DetectorProcessWorker:
    def __init__(self, detector: Detector) -> None:
        self.detector = detector
        self._process: Any | None = None
        self._connection: Connection | None = None
        self._request_id = 0
        self.last_pid: int | None = None

    @property
    def required(self) -> bool:
        return bool(getattr(self.detector, "required", True))

    @property
    def connection(self) -> Connection:
        if self._connection is None:
            raise DetectorExecutionError("the local detector worker is unavailable")
        return self._connection

    @property
    def active_pid(self) -> int | None:
        process = self._process
        if process is None or not process.is_alive():
            return None
        return int(process.pid)

    def start(self) -> None:
        if os.name != "posix" or "fork" not in multiprocessing.get_all_start_methods():
            raise DetectorUnavailableError(
                "local detector workers require POSIX fork support"
            )
        process = self._process
        if (
            process is not None
            and process.is_alive()
            and self._connection is not None
        ):
            return
        self.terminate()
        context = multiprocessing.get_context("fork")
        parent_connection, child_connection = context.Pipe(duplex=True)
        process = context.Process(
            target=_detector_worker_main,
            args=(self.detector, child_connection, parent_connection),
            name="privacy-codex-detector",
            daemon=True,
        )
        try:
            process.start()
        except (OSError, RuntimeError) as error:
            parent_connection.close()
            child_connection.close()
            raise DetectorUnavailableError(
                "failed to start a local detector worker"
            ) from error
        child_connection.close()
        self._process = process
        self._connection = parent_connection
        self.last_pid = int(process.pid)

    def dispatch(
        self,
        requests: list[tuple[str, DetectionContext]],
    ) -> int:
        connection = self.connection
        self._request_id += 1
        request_id = self._request_id
        try:
            connection.send(
                (
                    "detect",
                    _DETECTOR_WORKER_PROTOCOL,
                    request_id,
                    requests,
                )
            )
        except (BrokenPipeError, EOFError, OSError) as error:
            self.terminate()
            raise DetectorExecutionError(
                "a local detector worker failed"
            ) from error
        return request_id

    def receive(
        self,
        request_id: int,
        expected_batches: int,
    ) -> list[list[Span]]:
        try:
            response = self.connection.recv()
        except (EOFError, OSError) as error:
            self.terminate()
            raise DetectorExecutionError(
                "a local detector worker failed"
            ) from error
        if (
            not isinstance(response, tuple)
            or len(response) != 3
            or response[1] != request_id
        ):
            self.terminate()
            raise DetectorExecutionError(
                "a local detector worker returned invalid output"
            )
        status, _, payload = response
        if status != "ok":
            self.terminate()
            if status == "unavailable":
                raise DetectorUnavailableError(
                    "a required local detector dependency is unavailable"
                )
            raise DetectorExecutionError("a local detector worker failed")
        if (
            not isinstance(payload, list)
            or len(payload) != expected_batches
            or any(
                not isinstance(batch, list)
                or any(not isinstance(span, Span) for span in batch)
                for batch in payload
            )
        ):
            self.terminate()
            raise DetectorExecutionError(
                "a local detector worker returned invalid output"
            )
        return cast(list[list[Span]], payload)

    def close(self) -> None:
        process = self._process
        connection = self._connection
        if process is not None and process.is_alive() and connection is not None:
            try:
                connection.send(
                    ("shutdown", _DETECTOR_WORKER_PROTOCOL, 0, None)
                )
                if connection.poll(_DETECTOR_WORKER_GRACE_SECONDS):
                    connection.recv()
                process.join(_DETECTOR_WORKER_GRACE_SECONDS)
            except (BrokenPipeError, EOFError, OSError):
                pass
        self.terminate()

    def terminate(self) -> None:
        process = self._process
        connection = self._connection
        self._process = None
        self._connection = None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        if process is None:
            return
        if process.is_alive():
            try:
                process.terminate()
            except OSError:
                pass
        process.join(_DETECTOR_WORKER_GRACE_SECONDS)
        if process.is_alive():
            try:
                process.kill()
            except AttributeError:
                if process.pid is not None:
                    os.kill(process.pid, signal.SIGKILL)
            except OSError:
                pass
            process.join(_DETECTOR_WORKER_GRACE_SECONDS)
        still_alive = process.is_alive()
        if not still_alive:
            process.close()
        if still_alive:
            raise DetectorExecutionError(
                "a local detector worker could not be terminated"
            )


def _detector_worker_main(
    detector: Detector,
    connection: Connection,
    inherited_parent_connection: Connection,
) -> None:
    inherited_parent_connection.close()
    try:
        while True:
            try:
                request = connection.recv()
            except EOFError:
                return
            if (
                not isinstance(request, tuple)
                or len(request) != 4
                or request[1] != _DETECTOR_WORKER_PROTOCOL
            ):
                return
            command, _, request_id, payload = request
            if command == "shutdown":
                try:
                    connection.send(("closed", request_id, None))
                except (BrokenPipeError, OSError):
                    pass
                return
            if (
                command != "detect"
                or not isinstance(request_id, int)
                or not isinstance(payload, list)
            ):
                return
            try:
                batches: list[list[Span]] = []
                for item in payload:
                    if (
                        not isinstance(item, tuple)
                        or len(item) != 2
                        or not isinstance(item[0], str)
                        or not isinstance(item[1], DetectionContext)
                    ):
                        raise DetectorExecutionError(
                            "the detector worker received an invalid request"
                        )
                    batches.append(detector.detect(item[0], item[1]))
            except BaseException as error:
                status = (
                    "unavailable"
                    if isinstance(error, DetectorUnavailableError)
                    else "error"
                )
                try:
                    connection.send((status, request_id, None))
                except (BrokenPipeError, OSError):
                    pass
                continue
            try:
                connection.send(("ok", request_id, batches))
            except (BrokenPipeError, OSError):
                return
    finally:
        connection.close()


class DetectorOrchestrator:
    def __init__(
        self,
        detectors: Iterable[Detector],
        *,
        timeout_seconds: float = 10.0,
        max_workers: int = 4,
    ) -> None:
        self.detectors = list(detectors)
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("detector timeout must be a positive finite number")
        self.timeout_seconds = timeout_seconds
        self.max_workers = max(1, max_workers)
        ordered_detectors = sorted(
            enumerate(self.detectors),
            key=lambda item: (
                not isinstance(item[1], PrivacyFilterDetector),
                item[0],
            ),
        )
        self._workers = [
            _DetectorProcessWorker(detector)
            for _, detector in ordered_detectors
        ]
        self._request_lock = threading.RLock()

    def close(self) -> None:
        with self._request_lock:
            first_error: Exception | None = None
            for worker in self._workers:
                try:
                    worker.close()
                except Exception as error:
                    if first_error is None:
                        first_error = error
            if first_error is not None:
                raise first_error

    def active_worker_pid(self, detector: Detector) -> int | None:
        with self._request_lock:
            return self._worker_for(detector).active_pid

    def last_worker_pid(self, detector: Detector) -> int | None:
        with self._request_lock:
            return self._worker_for(detector).last_pid

    def __del__(self) -> None:
        try:
            self.close()
        except BaseException:
            pass

    def detect_sources(
        self,
        sources: list[TextSource],
        *,
        known_values: dict[str, list[str]] | None = None,
        evaluation_mode: bool = False,
    ) -> tuple[list[Span], dict[str, float]]:
        with self._request_lock:
            return self._detect_sources_locked(
                sources,
                known_values=known_values,
                evaluation_mode=evaluation_mode,
            )

    def _detect_sources_locked(
        self,
        sources: list[TextSource],
        *,
        known_values: dict[str, list[str]] | None,
        evaluation_mode: bool,
    ) -> tuple[list[Span], dict[str, float]]:
        started = time.perf_counter()
        deadline = started + self.timeout_seconds
        timings: dict[str, float] = {}
        results: list[Span] = []
        requests = [
            (
                source.text,
                DetectionContext(
                    source=source.name,
                    language=source.language,
                    known_values=known_values or {},
                    evaluation_mode=evaluation_mode,
                ),
            )
            for source in sources
        ]
        if not requests:
            timings["detectors_total"] = 0.0
            return [], timings

        ready_workers: list[_DetectorProcessWorker] = []
        for worker in self._workers:
            try:
                worker.start()
            except Exception as error:
                if worker.required:
                    self._terminate_workers(self._workers)
                    self._raise_required_failure(worker, error)
                continue
            ready_workers.append(worker)

        pending: dict[
            Connection,
            tuple[_DetectorProcessWorker, int, float],
        ] = {}
        for worker in ready_workers:
            if time.perf_counter() >= deadline:
                worker.terminate()
                if worker.required:
                    self._terminate_workers(self._workers)
                    raise DetectorExecutionError(
                        "a required detector exceeded its timeout"
                    )
                continue
            request_started = time.perf_counter()
            try:
                request_id = worker.dispatch(requests)
            except Exception as error:
                if worker.required:
                    self._terminate_workers(self._workers)
                    self._raise_required_failure(worker, error)
                continue
            pending[worker.connection] = (
                worker,
                request_id,
                request_started,
            )

        while pending:
            remaining = max(0.0, deadline - time.perf_counter())
            try:
                ready_connections = wait_connections(
                    tuple(pending),
                    timeout=remaining,
                )
            except (OSError, ValueError) as error:
                self._terminate_workers(self._workers)
                raise DetectorExecutionError(
                    "local detector IPC failed"
                ) from error
            if not ready_connections:
                timed_out_workers = [
                    worker
                    for worker, _, _ in pending.values()
                ]
                required_timed_out = any(
                    worker.required for worker in timed_out_workers
                )
                self._terminate_workers(timed_out_workers)
                if required_timed_out:
                    self._terminate_workers(self._workers)
                    raise DetectorExecutionError(
                        "a required detector exceeded its timeout"
                    )
                break
            for connection in ready_connections:
                worker, request_id, request_started = pending.pop(connection)
                try:
                    batches = worker.receive(
                        request_id,
                        expected_batches=len(requests),
                    )
                except Exception as error:
                    if worker.required:
                        self._terminate_workers(self._workers)
                        self._raise_required_failure(worker, error)
                    continue
                timings[f"{worker.detector.name}:batch"] = (
                    time.perf_counter() - request_started
                ) * 1000
                for batch in batches:
                    results.extend(batch)

        timings["detectors_total"] = (time.perf_counter() - started) * 1000
        results.sort(
            key=lambda span: (
                span.source,
                span.start,
                span.end,
                span.entity_type,
                span.detector,
            )
        )
        return _deduplicate(results), timings

    def _worker_for(self, detector: Detector) -> _DetectorProcessWorker:
        for worker in self._workers:
            if worker.detector is detector:
                return worker
        raise ValueError("detector does not belong to this orchestrator")

    def _terminate_workers(
        self,
        workers: Iterable[_DetectorProcessWorker],
    ) -> None:
        first_error: Exception | None = None
        seen: set[int] = set()
        for worker in workers:
            identity = id(worker)
            if identity in seen:
                continue
            seen.add(identity)
            try:
                worker.terminate()
            except Exception as error:
                if first_error is None:
                    first_error = error
        if first_error is not None:
            raise first_error

    @staticmethod
    def _raise_required_failure(
        worker: _DetectorProcessWorker,
        error: Exception,
    ) -> None:
        if isinstance(
            error,
            (DetectorUnavailableError, DetectorExecutionError),
        ):
            raise error
        raise DetectorExecutionError(
            f"required detector {worker.detector.name} failed"
        ) from error


def luhn_valid(digits: str) -> bool:
    if not digits.isdigit() or not 13 <= len(digits) <= 19:
        return False
    total = 0
    parity = len(digits) % 2
    for index, character in enumerate(digits):
        value = int(character)
        if index % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def iter_valid_payment_card_candidates(
    text: str,
) -> Iterable[re.Match[str]]:
    for match in PAYMENT_CARD_CANDIDATE.finditer(text):
        digits = "".join(
            character for character in match.group(0) if character.isdigit()
        )
        if luhn_valid(digits):
            yield match


def directory_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = file_path.relative_to(path).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with file_path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def _find_known_occurrences(
    text: str, value: str, *, identifier: bool
) -> list[tuple[int, int]]:
    flags = re.IGNORECASE if "@" in value or any(character.isalpha() for character in value) else 0
    pattern = re.escape(value)
    if identifier and value[0].isalnum() and value[-1].isalnum():
        pattern = rf"(?<![A-Za-z0-9]){pattern}(?![A-Za-z0-9])"
    return [(match.start(), match.end()) for match in re.finditer(pattern, text, flags)]


def _severity_for(entity_type: str) -> Severity:
    if entity_type in {
        "PAYMENT_CARD",
        "CVV",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "UNKNOWN_HIGH_RISK",
    }:
        return Severity.CRITICAL
    if entity_type in {
        "PERSON",
        "EMAIL",
        "PHONE",
        "PRIVATE_ADDRESS",
        "BOOKING_ID",
        "LOYALTY_ID",
        "ACCOUNT_ID",
        "PASSPORT_ID",
    }:
        return Severity.HIGH
    if entity_type in {"DATE", "IP_ADDRESS"}:
        return Severity.MEDIUM
    return Severity.LOW


def _is_identifier_type(entity_type: str) -> bool:
    return entity_type.endswith("_ID") or entity_type in {
        "PASSPORT",
        "BOOKING",
        "LOYALTY",
        "ACCOUNT",
    }


def _deduplicate(spans: list[Span]) -> list[Span]:
    seen: set[tuple[Any, ...]] = set()
    unique: list[Span] = []
    for span in spans:
        key = (
            span.source,
            span.start,
            span.end,
            span.entity_type,
            span.detector,
        )
        if key not in seen:
            seen.add(key)
            unique.append(span)
    return unique
