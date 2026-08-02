# Verification record

Date: 2026-07-26
Scope: local implementation and offline synthetic tests only

No real Codex request, private-gateway generation, remote model call, or online
model download was performed while producing this record.

## Automated checks

Command:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

Result: 86 tests passed and one explicit real-gateway smoke test was skipped.

Covered behaviors include exact English offsets, Unicode punctuation and
whitespace, semantic escapes and format controls, adjacent/overlapping spans,
separator-obfuscated payment cards, repeated values, reserved token input,
nonsensitive lookalikes,
malformed/unknown/bounded Codex events, timeout trees and missing output,
detector failure, PCI/credential blocking, isolated argv/stdin, artifact leak
prevention, AES-GCM failure/success, frozen-baseline safety, embedded prompt
injection, token mutation, binary input, reports, and dataset integrity.

`compileall` and the standard-library test suite passed. The optional
`pytest`, `hypothesis`, `ruff`, and `mypy` executables were not installed in the
bundled offline runtime, so those frontends were not run in this record.

## Deterministic detector benchmark

Command:

```bash
PYTHONPATH=src python scripts/benchmark_redactor.py \
  --dataset evals/english_synthetic.jsonl
```

Corpus: 50 generated English cases, including 25 extraction and 25 QA cases.
This corpus is templated and is not an independent or production-like test set.
Its frozen SHA-256 is
`c68aeafa3885930ec3be9f1cde1281da1da88bd6ec2614df9dc13142c406ed2c`.

Observed on the local Codex desktop runtime:

| Metric | Result |
|---|---:|
| Exact span/type precision | 100% |
| Exact span/type recall | 100% |
| Exact F1 | 100% |
| Character recall | 100% |
| Prompt-safe rate | 100% |
| False-positive detections | 0 |
| Critical PCI/credential/private-key recall | 100% |
| Exact true positives / false positives / false negatives | 304 / 0 / 0 |
| Warm 2,000-token rules-only p50 | 6.04 ms |
| Warm 2,000-token rules-only p95 | 6.19 ms |
| Warm 2,000-token rules-only p99 | 6.24 ms |

The exact timing is machine-dependent. It includes persistent process isolation
and IPC for the deterministic detector stack. The benchmark intentionally
excludes the required local classifier, so it does not prove the full-pipeline
p95 target.

## Feasibility gates

| Gate | Current status |
|---|---|
| Zero credential or PCI leaks on frozen supported-format suite | Passed on the synthetic fixture suite |
| At least 99% recall for validated critical identifiers | Passed on the synthetic fixture suite |
| At least 97% recall and 95% precision for contextual English PII | Passed on the templated suite; not validated on independent travel-support data |
| Exact restoration 100% for unchanged tokens | Passed in unit/integration fixtures |
| Utility CI lower bound above −2 percentage points | Not run; requires authorized real Codex benchmark |
| Warm full redaction p95 at or below 100 ms | Rules-only passed; local classifier remains to be measured |

The Codex CLI 0.131.0 parser accepted the complete isolated feature/config
surface and the explicit `private-gateway` environment-key provider in
non-generating probes. No inference request was made.

## Required next validation

1. Package the approved local privacy checkpoint from a private artifact
   registry in a digest-pinned, network-denied runtime.
2. Calibrate per-entity thresholds on the ten-case development split or a larger
   approved in-domain development corpus.
3. Freeze a genuinely independent English test set with ambiguous contextual
   PII and adversarial formatting.
4. Run the baseline/system/oracle benchmark through the configured private
   OpenAI-compatible gateway with `gpt-5.6-terra`, medium reasoning, and three
   repeats.
5. Review the safe HTML/CSV/JSON reports and enforce the stated privacy,
   utility, and full-pipeline latency gates.
