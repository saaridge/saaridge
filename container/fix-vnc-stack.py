#!/usr/bin/env python3
"""Restart x11vnc/websockify; ignore zombie PIDs (State Z)."""
import os
import signal
import subprocess
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


def main() -> None:
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
    print("killed", killed)
    time.sleep(0.6)

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
    time.sleep(0.8)

    alive = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if is_target(pid):
            alive.append((pid, comm(pid), status(pid)))
    print("alive", alive)
    print(subprocess.getoutput('ss -lnt | grep -E ":5900|:6080" || true'))
    print(subprocess.getoutput("DISPLAY=:1 xrandr | head -6"))


if __name__ == "__main__":
    main()
