#!/usr/bin/env python3
"""Ensure x11vnc + websockify are alive (ignore zombie PIDs).

Default is ensure-mode: leave a healthy stack alone. Pass --force to restart.
Liveness is port-based (:5900 RFB + :6080 websockify), not pgrep — a crashed
x11vnc can leave a zombie that still matches `pgrep -x x11vnc`.
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time


def status(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("State:"):
                    return line.split()[1]
    except OSError:
        return "?"
    return "?"


def cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def comm(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/comm", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def is_target(pid: int) -> bool:
    if status(pid) == "Z":
        return False
    name = comm(pid)
    cmd = cmdline(pid)
    return name == "x11vnc" or (
        name.startswith("python") and "websockify" in cmd and "--web=" in cmd
    )


def port_listening(port: int) -> bool:
    out = subprocess.getoutput(f'ss -lnt 2>/dev/null | grep -E ":{port}\\s" || true')
    return f":{port}" in out


def rfb_banner_ok(timeout: float = 2.0) -> bool:
    try:
        s = socket.create_connection(("127.0.0.1", 5900), timeout)
        s.settimeout(timeout)
        banner = s.recv(12)
        s.close()
        return banner.startswith(b"RFB ")
    except OSError:
        return False


def xvfb_alive() -> bool:
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if status(pid) == "Z":
            continue
        if comm(pid) == "Xvfb":
            return True
    return False


def stack_healthy() -> bool:
    return (
        xvfb_alive()
        and port_listening(5900)
        and port_listening(6080)
        and rfb_banner_ok()
    )


def kill_targets() -> list[int]:
    killed = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if not is_target(pid):
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(pid)
        except OSError:
            pass
    return killed


def wait_ports_free(timeout_s: float = 3.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not port_listening(5900) and not port_listening(6080):
            return
        time.sleep(0.1)


def start_stack() -> None:
    env = os.environ.copy()
    env["DISPLAY"] = ":1"
    with open("/tmp/x11vnc.log", "w", encoding="utf-8") as log:
        subprocess.Popen(
            [
                "x11vnc",
                "-display",
                ":1",
                "-forever",
                "-shared",
                "-rfbport",
                "5900",
                "-nopw",
                "-noncache",
                "-modtweak",
                "-xkb",
                "-noxdamage",
                "-noscrollcopyrect",
                "-always_inject",
                "-xrandr",
                "resize",
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
    with open("/tmp/novnc.log", "w", encoding="utf-8") as log:
        subprocess.Popen(
            [
                "websockify",
                "--web=/usr/share/novnc",
                "0.0.0.0:6080",
                "localhost:5900",
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


def main() -> int:
    force = "--force" in sys.argv
    if not force and stack_healthy():
        print("ok already-healthy")
        return 0

    if not xvfb_alive():
        print("error xvfb-down", file=sys.stderr)
        return 2

    killed = kill_targets()
    print("killed", killed)
    time.sleep(0.6)
    wait_ports_free()
    start_stack()

    for _ in range(20):
        time.sleep(0.25)
        if stack_healthy():
            print("ok repaired")
            print(subprocess.getoutput('ss -lnt | grep -E ":5900|:6080" || true'))
            return 0

    print("error repair-failed", file=sys.stderr)
    print(subprocess.getoutput('ss -lnt | grep -E ":5900|:6080" || true'), file=sys.stderr)
    print(subprocess.getoutput("tail -20 /tmp/x11vnc.log || true"), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
