#!/usr/bin/env python3
"""Client for the root workspace-ops daemon."""
from __future__ import annotations

import json
import socket
import sys

SOCK = "/var/run/bridge/workspace-ops.sock"


def call(req: dict) -> dict:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(620)
    try:
        s.connect(SOCK)
        s.sendall((json.dumps(req) + "\n").encode())
        data = b""
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
            if b"\n" in data:
                break
    finally:
        try:
            s.close()
        except OSError:
            pass
    line = data.decode("utf-8", errors="replace").strip().splitlines()
    if not line:
        return {"ok": False, "error": "Empty response from workspace ops"}
    try:
        return json.loads(line[0])
    except json.JSONDecodeError:
        return {"ok": False, "error": "Bad response from workspace ops"}


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: workspace-ops-client.py ping|install <path>|uninstall <package>",
            file=sys.stderr,
        )
        return 2
    op = sys.argv[1]
    if op == "ping":
        print(json.dumps(call({"op": "ping"})))
        return 0
    if op == "uninstall":
        if len(sys.argv) < 3:
            print(json.dumps({"ok": False, "error": "package required"}))
            return 1
        resp = call({"op": "uninstall", "package": sys.argv[2]})
        print(json.dumps(resp))
        return 0 if resp.get("ok") else 1
    if op == "install":
        if len(sys.argv) < 3:
            print(json.dumps({"ok": False, "error": "path required"}))
            return 1
        resp = call({"op": "install", "path": sys.argv[2]})
        print(json.dumps(resp))
        return 0 if resp.get("ok") else 1
    print(json.dumps({"ok": False, "error": f"unknown op {op}"}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
