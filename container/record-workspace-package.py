#!/usr/bin/env python3
"""Add or remove an entry in the Install Assistant package manifest."""
from __future__ import annotations

import json
import os
import sys

MANIFEST = "/home/browser/.local/share/onebridge/workspace-packages.json"


def load() -> list[dict]:
    if not os.path.isfile(MANIFEST):
        return []
    try:
        data = json.load(open(MANIFEST, encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def save(data: list[dict]) -> None:
    os.makedirs(os.path.dirname(MANIFEST), mode=0o700, exist_ok=True)
    json.dump(data, open(MANIFEST, "w", encoding="utf-8"), indent=2)
    os.chmod(MANIFEST, 0o600)


def add(pkg: str, name: str, kind: str) -> None:
    data = [e for e in load() if isinstance(e, dict) and e.get("package") != pkg]
    data.append({"package": pkg, "name": name or pkg, "kind": kind or "deb"})
    save(data)


def remove(pkg: str) -> None:
    data = [e for e in load() if isinstance(e, dict) and e.get("package") != pkg]
    save(data)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: record-workspace-package.py add|remove PKG [NAME] [KIND]", file=sys.stderr)
        return 2
    cmd, pkg = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""
    pkg = pkg.strip()
    if not pkg:
        return 2
    if cmd == "add":
        name = sys.argv[3] if len(sys.argv) > 3 else pkg
        kind = sys.argv[4] if len(sys.argv) > 4 else "deb"
        add(pkg, name, kind)
        return 0
    if cmd == "remove":
        remove(pkg)
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
