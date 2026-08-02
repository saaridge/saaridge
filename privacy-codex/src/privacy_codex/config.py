from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tomllib

from .models import CodexConfig


@dataclass(frozen=True)
class DetectorSettings:
    require_classifier: bool = True
    classifier_model_path: Path | None = None
    classifier_model_digest: str | None = None
    edge_model_path: Path | None = None
    edge_model_digest: str | None = None
    edge_model_required: bool = False
    edge_model_threshold: float = 0.80
    classifier_timeout_seconds: float = 10.0
    max_workers: int = 4
    thresholds: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeSettings:
    runs_dir: Path = Path("runs")
    timeout_seconds: float = 300.0
    max_input_bytes: int = 2_000_000


@dataclass(frozen=True)
class PolicySettings:
    version: str = "poc-en-v1"
    unknown_high_risk_action: str = "BLOCK"


@dataclass(frozen=True)
class AppConfig:
    runtime: RuntimeSettings = RuntimeSettings()
    detectors: DetectorSettings = DetectorSettings()
    policy: PolicySettings = PolicySettings()
    codex: CodexConfig = CodexConfig()


def load_config(path: Path | None = None) -> AppConfig:
    if path is None:
        return AppConfig()
    with path.open("rb") as handle:
        raw = tomllib.load(handle)
    return _from_mapping(raw, base_dir=path.parent.resolve())


def _from_mapping(
    raw: dict[str, Any],
    *,
    base_dir: Path | None = None,
) -> AppConfig:
    runtime_raw = dict(raw.get("runtime", {}))
    detector_raw = dict(raw.get("detectors", {}))
    policy_raw = dict(raw.get("policy", {}))
    codex_raw = dict(raw.get("codex", {}))

    timeout_seconds = float(runtime_raw.get("timeout_seconds", 300.0))
    max_input_bytes = int(runtime_raw.get("max_input_bytes", 2_000_000))
    if timeout_seconds <= 0 or max_input_bytes <= 0:
        raise ValueError("runtime timeout and input-size limit must be positive")
    runtime = RuntimeSettings(
        runs_dir=Path(runtime_raw.get("runs_dir", "runs")),
        timeout_seconds=timeout_seconds,
        max_input_bytes=max_input_bytes,
    )
    model_path_value = detector_raw.get("classifier_model_path")
    classifier_model_path: Path | None = None
    if model_path_value:
        classifier_model_path = Path(str(model_path_value))
        if not classifier_model_path.is_absolute() and base_dir is not None:
            classifier_model_path = (base_dir / classifier_model_path).resolve()
    require_classifier = detector_raw.get("require_classifier", True)
    if type(require_classifier) is not bool:
        raise ValueError("detectors.require_classifier must be a boolean")
    classifier_timeout_seconds = float(
        detector_raw.get("classifier_timeout_seconds", 10.0)
    )
    max_workers = int(detector_raw.get("max_workers", 4))
    if classifier_timeout_seconds <= 0 or max_workers <= 0:
        raise ValueError("detector timeout and worker count must be positive")
    model_digest_value = detector_raw.get("classifier_model_digest")
    classifier_model_digest = (
        str(model_digest_value).strip() if model_digest_value else None
    )
    if classifier_model_digest and not re.fullmatch(
        r"[0-9a-fA-F]{64}", classifier_model_digest
    ):
        raise ValueError("classifier_model_digest must be a 64-character SHA-256")
    edge_model_path_value = detector_raw.get("edge_model_path")
    edge_model_path: Path | None = None
    if edge_model_path_value:
        edge_model_path = Path(str(edge_model_path_value))
        if not edge_model_path.is_absolute() and base_dir is not None:
            edge_model_path = (base_dir / edge_model_path).resolve()
    edge_model_digest_value = detector_raw.get("edge_model_digest")
    edge_model_digest = (
        str(edge_model_digest_value).strip() if edge_model_digest_value else None
    )
    if edge_model_digest and not re.fullmatch(
        r"[0-9a-fA-F]{64}", edge_model_digest
    ):
        raise ValueError("edge_model_digest must be a 64-character SHA-256")
    edge_model_required = detector_raw.get("edge_model_required", False)
    if type(edge_model_required) is not bool:
        raise ValueError("detectors.edge_model_required must be a boolean")
    edge_model_threshold = float(detector_raw.get("edge_model_threshold", 0.80))
    if not 0.0 <= edge_model_threshold <= 1.0:
        raise ValueError("detectors.edge_model_threshold must be between 0 and 1")
    thresholds = {
        str(key).upper(): float(value)
        for key, value in dict(detector_raw.get("thresholds", {})).items()
    }
    if any(not 0.0 <= value <= 1.0 for value in thresholds.values()):
        raise ValueError("detector thresholds must be between 0 and 1")
    detectors = DetectorSettings(
        require_classifier=require_classifier,
        classifier_model_path=classifier_model_path,
        classifier_model_digest=classifier_model_digest,
        edge_model_path=edge_model_path,
        edge_model_digest=edge_model_digest,
        edge_model_required=edge_model_required,
        edge_model_threshold=edge_model_threshold,
        classifier_timeout_seconds=classifier_timeout_seconds,
        max_workers=max_workers,
        thresholds=thresholds,
    )
    unknown_high_risk_action = str(
        policy_raw.get("unknown_high_risk_action", "BLOCK")
    ).upper()
    if unknown_high_risk_action != "BLOCK":
        raise ValueError("UNKNOWN_HIGH_RISK is immutable and must use BLOCK")
    policy = PolicySettings(
        version=str(policy_raw.get("version", "poc-en-v1")),
        unknown_high_risk_action=unknown_high_risk_action,
    )
    codex = CodexConfig(
        executable=str(codex_raw.get("executable", "codex")),
        required_version=str(codex_raw.get("required_version", "0.131.0")),
        model=str(codex_raw.get("model", "gpt-5.6-terra")),
        reasoning_effort=str(codex_raw.get("reasoning_effort", "medium")),
        base_url=str(
            codex_raw.get(
                "base_url", "https://llm-gateway.example.test/v1"
            )
        ),
        allowed_gateway_hosts=_gateway_hosts(
            codex_raw.get(
                "allowed_gateway_hosts",
                ["llm-gateway.example.test"],
            )
        ),
        timeout_seconds=float(
            codex_raw.get("timeout_seconds", runtime.timeout_seconds)
        ),
    )
    return AppConfig(runtime=runtime, detectors=detectors, policy=policy, codex=codex)


def _gateway_hosts(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError("codex.allowed_gateway_hosts must be a non-empty array")
    hosts: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(
                "codex.allowed_gateway_hosts entries must be non-empty strings"
            )
        hosts.append(item)
    return tuple(hosts)
