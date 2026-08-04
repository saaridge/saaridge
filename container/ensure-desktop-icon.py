#!/usr/bin/env python3
"""Create a desktop launcher for an installed .deb package. Prints OK|Name|path or NO_DESKTOP."""
from __future__ import annotations

import glob
import os
import subprocess
import sys


def find_desktop(pkg: str) -> str | None:
    if pkg:
        try:
            r = subprocess.run(
                ["dpkg", "-L", pkg], capture_output=True, text=True, timeout=30
            )
            for line in (r.stdout or "").splitlines():
                f = line.strip()
                if not f.endswith(".desktop") or not os.path.isfile(f):
                    continue
                if "url-handler" in f:
                    continue
                text = open(f, encoding="utf-8", errors="replace").read()
                if "Type=Application" in text:
                    return f
        except (OSError, subprocess.TimeoutExpired):
            pass
    for cand in sorted(glob.glob("/usr/share/applications/*.desktop")):
        if "url-handler" in cand:
            continue
        base = os.path.splitext(os.path.basename(cand))[0]
        if pkg and base == pkg:
            return cand
    return None


def rewrite(src: str, dest: str, pkg: str) -> None:
    text = open(src, encoding="utf-8", errors="replace").read().splitlines()
    out = []
    in_action = False
    saw_pkg = False
    for line in text:
        if line.startswith("[Desktop Action"):
            in_action = True
            continue
        if line.startswith("[") and line.endswith("]"):
            in_action = False
        if in_action:
            continue
        if line.startswith("Actions="):
            continue
        if line.startswith("Exec="):
            parts = line[5:].split()
            if parts:
                bin0 = parts[0]
                rest = [p for p in parts[1:] if not p.startswith("%")]
                flags = []
                low = bin0.lower()
                is_cursor = "cursor" in low
                # Cursor: route through launch-cursor.sh (proxy + MITM CA env).
                if is_cursor and os.path.isfile("/opt/bridge/launch-cursor.sh"):
                    bin0 = "/opt/bridge/launch-cursor.sh"
                    rest = []
                    flags = []
                elif any(x in low for x in ("cursor", "chrom", "code", "electron")):
                    for f in ("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"):
                        if f not in rest:
                            flags.append(f)
                codes = [p for p in parts[1:] if p.startswith("%")]
                # Cursor: open mediated host workspace by default (Open Folder sees this path)
                project = (
                    os.environ.get("CURSOR_PROJECT_DIR")
                    or os.environ.get("ONEBRIDGE_PROJECTS")
                    or ""
                ).strip()
                if is_cursor and project and not any(
                    p.startswith("/host/") or p == project for p in rest
                ):
                    rest.append(project)
                    codes = []  # folder path replaces %F for the desktop launcher
                line = "Exec=" + " ".join([bin0, *flags, *rest, *codes])
        if line.startswith("Icon="):
            icon = line[5:].strip()
            if icon and not icon.startswith("/"):
                for p in (
                    f"/usr/share/pixmaps/{icon}.png",
                    f"/usr/share/pixmaps/{icon}.svg",
                    f"/usr/share/pixmaps/{icon}.xpm",
                    f"/usr/share/icons/hicolor/48x48/apps/{icon}.png",
                    f"/usr/share/icons/hicolor/128x128/apps/{icon}.png",
                    f"/usr/share/icons/hicolor/256x256/apps/{icon}.png",
                ):
                    if os.path.isfile(p):
                        line = f"Icon={p}"
                        break
        if line.startswith("X-OneBridge-Package="):
            saw_pkg = True
            if pkg:
                line = f"X-OneBridge-Package={pkg}"
        out.append(line)
    if pkg and not saw_pkg:
        out.append(f"X-OneBridge-Package={pkg}")
    open(dest, "w", encoding="utf-8").write("\n".join(out) + "\n")


def main() -> int:
    pkg = sys.argv[1] if len(sys.argv) > 1 else ""
    deb_base = sys.argv[2] if len(sys.argv) > 2 else "App.deb"
    home = os.environ.get("HOME") or "/home/browser"
    desktop_dir = os.path.join(home, "Desktop")
    apps_dir = os.path.join(home, ".local", "share", "applications")
    os.makedirs(desktop_dir, exist_ok=True)
    os.makedirs(apps_dir, exist_ok=True)

    src = find_desktop(pkg)
    if not src:
        print("NO_DESKTOP")
        return 0

    name = pkg or deb_base.replace(".deb", "")
    for line in open(src, encoding="utf-8", errors="replace"):
        if line.startswith("Name=") and not line.startswith("Name["):
            name = line.split("=", 1)[1].strip() or name
            break
    safe = "".join(c for c in name if c.isalnum() or c in " ._-" ).strip() or "App"
    dest_app = os.path.join(apps_dir, f"onebridge-{safe.replace(' ', '_')}.desktop")
    dest_desktop = os.path.join(desktop_dir, f"{safe}.desktop")
    rewrite(src, dest_app, pkg)
    os.chmod(dest_app, 0o755)
    open(dest_desktop, "wb").write(open(dest_app, "rb").read())
    os.chmod(dest_desktop, 0o755)
    try:
        subprocess.run(
            ["gio", "set", dest_desktop, "metadata::trusted", "true"],
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        subprocess.run(["xfdesktop", "--reload"], capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass
    print(f"OK|{safe}|{dest_desktop}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
