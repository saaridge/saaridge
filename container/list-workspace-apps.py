#!/usr/bin/env python3
"""List apps installed via Install Assistant (for uninstall UI + control plane)."""
from __future__ import annotations

import glob
import json
import os
import subprocess


MANIFEST = "/home/browser/.local/share/onebridge/workspace-packages.json"
SKIP_DESKTOP = frozenset(
    {
        "Install Assistant.desktop",
        "onebridge-install-assistant.desktop",
        "onebridge-browser.desktop",
    }
)


def dpkg_installed(pkg: str) -> bool:
    if not pkg or pkg.startswith("appimage:"):
        return False
    try:
        r = subprocess.run(
            ["dpkg-query", "-W", "-f=${Status}", pkg],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "install ok installed" in (r.stdout or "")


def parse_desktop(path: str) -> tuple[str, str]:
    """Return (label, package_id) from a .desktop file."""
    label = os.path.splitext(os.path.basename(path))[0]
    pkg = ""
    in_action = False
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if line.startswith("[Desktop Action"):
                    in_action = True
                    continue
                if line.startswith("[") and line.endswith("]"):
                    in_action = False
                    continue
                if in_action:
                    continue
                if line.startswith("Name=") and not line.startswith("Name["):
                    label = line.split("=", 1)[1].strip() or label
                if line.startswith("X-OneBridge-Package="):
                    pkg = line.split("=", 1)[1].strip()
    except OSError:
        return label, ""
    if not pkg and label.lower() == "cursor":
        pkg = "cursor"
    return label, pkg


def load_manifest() -> list[dict]:
    if not os.path.isfile(MANIFEST):
        return []
    try:
        data = json.load(open(MANIFEST, encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, dict) and item.get("package"):
            out.append(item)
    return out


def collect_from_desktops() -> dict[str, dict]:
    by_pkg: dict[str, dict] = {}
    patterns = [
        "/home/browser/Desktop/*.desktop",
        "/home/browser/.local/share/applications/onebridge-*.desktop",
        "/home/browser/.local/share/applications/*.desktop",
    ]
    seen_paths: set[str] = set()
    for pattern in patterns:
        for path in sorted(glob.glob(pattern)):
            if path in seen_paths:
                continue
            seen_paths.add(path)
            base = os.path.basename(path)
            if base in SKIP_DESKTOP:
                continue
            if base == "Install Assistant.desktop":
                continue
            label, pkg = parse_desktop(path)
            if not pkg:
                continue
            by_pkg[pkg] = {"name": label, "package": pkg, "desktop": path}
    return by_pkg


def main() -> int:
    by_pkg = collect_from_desktops()

    for item in load_manifest():
        pkg = str(item.get("package") or "").strip()
        if not pkg or pkg in by_pkg:
            continue
        kind = str(item.get("kind") or "deb")
        name = str(item.get("name") or pkg)
        if kind == "deb" and not dpkg_installed(pkg):
            continue
        if kind.startswith("appimage:"):
            app_name = pkg.split(":", 1)[-1]
            app_path = f"/home/browser/Applications/{app_name}.AppImage"
            if not os.path.isfile(app_path):
                alt = f"/home/browser/Applications/{app_name}.appimage"
                if not os.path.isfile(alt):
                    continue
        by_pkg[pkg] = {"name": name, "package": pkg, "desktop": item.get("desktop") or ""}

    # Installed .debs with a OneBridge launcher but no Desktop icon yet
    for path in glob.glob("/home/browser/.local/share/applications/onebridge-*.desktop"):
        base = os.path.basename(path)
        if base in SKIP_DESKTOP:
            continue
        label, pkg = parse_desktop(path)
        if pkg and pkg not in by_pkg and dpkg_installed(pkg.split(":")[0]):
            by_pkg[pkg] = {"name": label, "package": pkg, "desktop": path}

    apps = sorted(by_pkg.values(), key=lambda a: (a.get("name") or "").lower())
    if "cursor" not in by_pkg and dpkg_installed("cursor"):
        apps.append({"name": "Cursor", "package": "cursor", "desktop": ""})
        apps.sort(key=lambda a: (a.get("name") or "").lower())
    print(json.dumps(apps))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
