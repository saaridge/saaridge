#!/usr/bin/env python3
"""Root-side workspace ops helper (install/uninstall) via a unix socket.

Runs as root from entrypoint. Install Assistant (browser user) can call:
  python3 /opt/bridge/workspace-ops-client.py install <path>
  python3 /opt/bridge/workspace-ops-client.py uninstall <package>
without needing sudo (blocked by Docker no-new-privileges).
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys

SOCK = "/var/run/bridge/workspace-ops.sock"
UNINSTALL_SH = "/opt/bridge/uninstall-workspace-app.sh"
INSTALL_SH = "/opt/bridge/install-workspace-app.sh"


def _run_script(script: str, arg: str, timeout: int) -> dict:
    if not os.path.isfile(script):
        return {"ok": False, "error": f"Helper missing: {script}"}
    try:
        r = subprocess.run(
            ["bash", script, arg],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Operation timed out"}
    out = (r.stdout or "").strip().splitlines()
    last = out[-1] if out else ""
    try:
        return json.loads(last)
    except json.JSONDecodeError:
        if r.returncode == 0:
            return {"ok": True}
        err = (r.stderr or r.stdout or "Operation failed").strip()[-500]
        return {"ok": False, "error": err or "Operation failed"}


def handle(req: dict) -> dict:
    op = str(req.get("op") or "").strip()
    if op == "ping":
        return {"ok": True, "pong": True}
    if op == "uninstall":
        pkg = str(req.get("package") or "").strip()
        if not pkg or ".." in pkg or "/" in pkg or "\0" in pkg:
            return {"ok": False, "error": "Invalid package"}
        return _run_script(UNINSTALL_SH, pkg, 300)
    if op == "install":
        path = str(req.get("path") or "").strip()
        if not path or "\0" in path or ".." in path:
            return {"ok": False, "error": "Invalid path"}
        if not (
            path.startswith("/home/browser/")
            or path.startswith("/tmp/")
            or path.startswith("/var/tmp/")
        ):
            return {"ok": False, "error": "Pick a file inside the workspace filesystem"}
        return _run_script(INSTALL_SH, path, 600)
    return {"ok": False, "error": f"Unknown op: {op}"}


def serve() -> int:
    os.makedirs(os.path.dirname(SOCK), mode=0o755, exist_ok=True)
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    os.chmod(SOCK, 0o666)
    srv.listen(5)
    print(f"[workspace-ops] listening on {SOCK}", flush=True)
    while True:
        conn, _ = srv.accept()
        try:
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in data:
                    break
            line = data.decode("utf-8", errors="replace").strip().splitlines()
            req = {}
            if line:
                try:
                    req = json.loads(line[0])
                except json.JSONDecodeError:
                    req = {}
            resp = handle(req if isinstance(req, dict) else {})
            conn.sendall((json.dumps(resp) + "\n").encode())
        except Exception as e:
            try:
                conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
            except OSError:
                pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


if __name__ == "__main__":
    if os.geteuid() != 0:
        print("must run as root", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(serve())
