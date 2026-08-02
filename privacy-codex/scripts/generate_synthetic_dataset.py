#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from privacy_codex.synthetic import (
    generate_english_cases,
    validate_generated_cases,
    write_english_dataset,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        default=Path("evals/english_synthetic.jsonl"),
    )
    arguments = parser.parse_args()
    cases = generate_english_cases()
    validate_generated_cases(cases)
    write_english_dataset(arguments.output)
    print(f"wrote {len(cases)} cases to {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
