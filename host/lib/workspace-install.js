import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dockerCp, dockerExec, containerRunning } from "./docker.js";
import { installAgentFromHostPath } from "../control-plane/agents.js";
import { CONTAINER_NAME, STATE_DIR } from "./paths.js";
import { logError, logStep } from "./logger.js";

export const DOWNLOADS_DIR = "/home/browser/Downloads";

const ARCHIVE_RE = /\.(zip|tgz|tar\.gz|onebridge\.zip)$/i;

const run = (command, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: String(err) }),
    );
  });

const safeBasename = (name) => {
  const base = path.basename(String(name || ""));
  if (!base || base === "." || base === ".." || base.includes("\0")) return null;
  if (base !== String(name || "").replace(/^.*[/\\]/, "")) return null;
  return base;
};

const readAgentName = (agentDir) => {
  try {
    const raw = fs.readFileSync(path.join(agentDir, "agent.json"), "utf8");
    const j = JSON.parse(raw);
    return j.name || path.basename(agentDir);
  } catch {
    return null;
  }
};

const findAgentRoot = (root) => {
  const direct = path.join(root, "agent.json");
  if (fs.existsSync(direct)) return root;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const nested = path.join(root, ent.name);
    if (fs.existsSync(path.join(nested, "agent.json"))) return nested;
  }
  // One more level for zip quirks
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const nested = path.join(root, ent.name);
    try {
      for (const child of fs.readdirSync(nested, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        const deep = path.join(nested, child.name);
        if (fs.existsSync(path.join(deep, "agent.json"))) return deep;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
};

const looksInstallableName = (name) =>
  ARCHIVE_RE.test(name) || name.toLowerCase().endsWith(".onebridge");

/**
 * List installable packages the user downloaded into the workspace Downloads folder.
 */
export const listWorkspaceDownloadPackages = async () => {
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running", packages: [] };
  }

  const listed = await dockerExec(
    [
      "bash",
      "-lc",
      [
        `mkdir -p ${JSON.stringify(DOWNLOADS_DIR)}`,
        `cd ${JSON.stringify(DOWNLOADS_DIR)} || exit 0`,
        `python3 - <<'PY'`,
        `import json, os, time`,
        `root = ${JSON.stringify(DOWNLOADS_DIR)}`,
        `out = []`,
        `for name in sorted(os.listdir(root)):`,
        `  if name.startswith('.'):`,
        `    continue`,
        `  p = os.path.join(root, name)`,
        `  try:`,
        `    st = os.stat(p)`,
        `  except OSError:`,
        `    continue`,
        `  is_dir = os.path.isdir(p)`,
        `  has_manifest = is_dir and os.path.isfile(os.path.join(p, 'agent.json'))`,
        `  low = name.lower()`,
        `  is_archive = low.endswith(('.zip', '.tgz', '.tar.gz', '.onebridge.zip', '.onebridge'))`,
        `  if not (has_manifest or is_archive):`,
        `    continue`,
        `  agent_name = None`,
        `  if has_manifest:`,
        `    try:`,
        `      import json as _j`,
        `      agent_name = _j.load(open(os.path.join(p, 'agent.json'))).get('name')`,
        `    except Exception:`,
        `      agent_name = None`,
        `  out.append({`,
        `    'name': name,`,
        `    'kind': 'folder' if has_manifest else 'archive',`,
        `    'bytes': st.st_size,`,
        `    'mtime': int(st.st_mtime),`,
        `    'agentName': agent_name,`,
        `  })`,
        `print(json.dumps(out))`,
        `PY`,
      ].join("\n"),
    ],
    { user: "browser" },
  );

  if (listed.code !== 0) {
    return {
      ok: false,
      error: listed.stderr || listed.stdout || "Could not list Downloads",
      packages: [],
    };
  }

  let packages = [];
  try {
    packages = JSON.parse((listed.stdout || "").trim() || "[]");
  } catch {
    packages = [];
  }

  return {
    ok: true,
    downloadsDir: DOWNLOADS_DIR,
    packages,
    hint:
      packages.length === 0
        ? "Download an assistant package with the Web Browser, then come back here."
        : null,
  };
};

const unpackArchive = async (archivePath, destDir) => {
  fs.mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".onebridge.zip") || lower.endsWith(".onebridge")) {
    const r = await run("unzip", ["-q", "-o", archivePath, "-d", destDir]);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || "unzip failed");
    return;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const r = await run("tar", ["-xzf", archivePath, "-C", destDir]);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || "tar failed");
    return;
  }
  throw new Error("Unsupported package type");
};

const stagePackageFromDownloads = async (basename) => {
  const safe = safeBasename(basename);
  if (!safe) throw new Error("Invalid package name");

  const stagingRoot = path.join(STATE_DIR, "staging");
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = path.join(
    stagingRoot,
    `dl-${Date.now()}-${safe.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40)}`,
  );
  fs.mkdirSync(staging, { recursive: true });

  const containerPath = `${DOWNLOADS_DIR}/${safe}`;
  const exists = await dockerExec([
    "bash",
    "-lc",
    `if [[ -e ${JSON.stringify(containerPath)} ]]; then echo YES; else echo NO; fi`,
  ]);
  if (!(exists.stdout || "").includes("YES")) {
    throw new Error(`Package not found in Downloads: ${safe}`);
  }

  const isDir = await dockerExec([
    "bash",
    "-lc",
    `if [[ -d ${JSON.stringify(containerPath)} ]]; then echo DIR; else echo FILE; fi`,
  ]);

  if ((isDir.stdout || "").includes("DIR")) {
    const dest = path.join(staging, "pkg");
    fs.mkdirSync(dest, { recursive: true });
    const cp = await dockerCp(`${CONTAINER_NAME}:${containerPath}/.`, dest);
    if (cp.code !== 0) throw new Error(cp.stderr || cp.stdout || "copy failed");
    const root = findAgentRoot(dest);
    if (!root) throw new Error("No agent.json found in that folder");
    return { staging, agentDir: root, displayName: readAgentName(root) || safe };
  }

  const archiveHost = path.join(staging, safe);
  const cp = await dockerCp(`${CONTAINER_NAME}:${containerPath}`, archiveHost);
  if (cp.code !== 0) throw new Error(cp.stderr || cp.stdout || "copy failed");
  if (!looksInstallableName(safe) && !ARCHIVE_RE.test(safe)) {
    throw new Error("That file is not an assistant package");
  }

  const unpacked = path.join(staging, "unpacked");
  await unpackArchive(archiveHost, unpacked);
  const root = findAgentRoot(unpacked);
  if (!root) {
    throw new Error(
      "This download is not a OneBridge assistant (missing agent.json)",
    );
  }
  return { staging, agentDir: root, displayName: readAgentName(root) || safe };
};

const cleanupStaging = (staging) => {
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

/**
 * Install an assistant from a file/folder the user downloaded into the workspace.
 */
export const installAgentFromWorkspaceDownload = async (filename) => {
  const safe = safeBasename(filename);
  if (!safe) {
    return { ok: false, error: "Pick a package from Downloads" };
  }

  let staging = null;
  try {
    logStep("Staging assistant package from Downloads", { file: safe });
    const staged = await stagePackageFromDownloads(safe);
    staging = staged.staging;
    const result = await installAgentFromHostPath(staged.agentDir);
    if (result.ok) {
      logStep("Installed assistant from Downloads", {
        file: safe,
        agentId: result.agentId,
        name: staged.displayName,
      });
    }
    return {
      ...result,
      sourceFile: safe,
      displayName: staged.displayName,
    };
  } catch (err) {
    logError("Install from Downloads failed", {
      file: safe,
      detail: String(err?.message || err),
    });
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (staging) cleanupStaging(staging);
  }
};

/**
 * Install an assistant from a package file already on the host filesystem
 * (e.g. Electron Install Assistant download).
 */
export const installAgentFromHostArchive = async (hostFilePath) => {
  const resolved = path.resolve(String(hostFilePath || ""));
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "Downloaded file not found" };
  }

  const base = path.basename(resolved);
  let staging = null;
  try {
    logStep("Staging assistant package from host download", { file: base });
    const stagingRoot = path.join(STATE_DIR, "staging");
    fs.mkdirSync(stagingRoot, { recursive: true });
    staging = path.join(
      stagingRoot,
      `host-${Date.now()}-${base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40)}`,
    );
    fs.mkdirSync(staging, { recursive: true });

    let agentDir;
    let displayName;
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      agentDir = findAgentRoot(resolved);
      if (!agentDir) {
        throw new Error("No agent.json found in that folder");
      }
      displayName = readAgentName(agentDir) || base;
    } else {
      if (!ARCHIVE_RE.test(base) && !base.toLowerCase().endsWith(".onebridge")) {
        throw new Error(
          "That file is not a OneBridge assistant package (.zip / .tgz)",
        );
      }
      const unpacked = path.join(staging, "unpacked");
      await unpackArchive(resolved, unpacked);
      agentDir = findAgentRoot(unpacked);
      if (!agentDir) {
        throw new Error(
          "This download is not a OneBridge assistant (missing agent.json)",
        );
      }
      displayName = readAgentName(agentDir) || base;
    }

    const result = await installAgentFromHostPath(agentDir);
    if (result.ok) {
      logStep("Installed assistant from host download", {
        file: base,
        agentId: result.agentId,
        name: displayName,
      });
    }
    return { ...result, sourceFile: base, displayName };
  } catch (err) {
    logError("Install from host download failed", {
      file: base,
      detail: String(err?.message || err),
    });
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (staging) cleanupStaging(staging);
  }
};

/**
 * Install a package that lives inside the workspace container filesystem
 * (zenity/GTK file picker under /home/browser).
 * Supports:
 *  - .deb → dpkg install inside the workspace
 *  - .zip / .tgz / .onebridge → OneBridge assistant package
 */
export const installAgentFromWorkspacePath = async (workspacePath) => {
  const raw = String(workspacePath || "").trim();
  // Allow any file the workspace user can see (home + common download/tmp paths).
  const allowed =
    raw.startsWith("/home/browser/") ||
    raw.startsWith("/tmp/") ||
    raw.startsWith("/var/tmp/");
  if (!allowed || raw.includes("\0") || raw.includes("..")) {
    return { ok: false, error: "Pick a file inside the workspace filesystem" };
  }
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running" };
  }

  const base = path.basename(raw);
  const lower = base.toLowerCase();

  // Native Linux installer packages — install inside the workspace.
  if (lower.endsWith(".deb")) {
    return installDebInWorkspace(raw, base);
  }
  if (lower.endsWith(".appimage")) {
    return installAppImageInWorkspace(raw, base);
  }

  const stagingRoot = path.join(STATE_DIR, "staging");
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = path.join(
    stagingRoot,
    `ws-${Date.now()}-${base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40)}`,
  );
  fs.mkdirSync(staging, { recursive: true });
  const hostCopy = path.join(staging, base);

  try {
    logStep("Copying workspace package to host for install", { path: raw });
    const cp = await dockerCp(`${CONTAINER_NAME}:${raw}`, hostCopy);
    if (cp.code !== 0 || !fs.existsSync(hostCopy)) {
      throw new Error(cp.stderr || cp.stdout || "Could not read that file from the workspace");
    }
    return await installAgentFromHostArchive(hostCopy);
  } catch (err) {
    logError("Install from workspace path failed", {
      path: raw,
      detail: String(err?.message || err),
    });
    return { ok: false, error: String(err?.message || err) };
  } finally {
    cleanupStaging(staging);
  }
};

const installDebInWorkspace = async (workspacePath, base) => {
  logStep("Installing .deb inside workspace", { path: workspacePath });
  const res = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "set +e",
        `FILE=${JSON.stringify(workspacePath)}`,
        'if [[ ! -f "$FILE" ]]; then echo "File not found"; exit 1; fi',
        "export DEBIAN_FRONTEND=noninteractive",
        'OUT=$(dpkg -i "$FILE" 2>&1)',
        "CODE=$?",
        'echo "$OUT"',
        "if [[ $CODE -ne 0 ]]; then",
        "  apt-get install -y -f -qq 2>&1",
        '  OUT=$(dpkg -i "$FILE" 2>&1)',
        "  CODE=$?",
        '  echo "$OUT"',
        "fi",
        "exit $CODE",
      ].join("\n"),
    ],
    { user: "root", timeoutMs: 300_000 },
  );
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "dpkg failed").trim().slice(-800);
    logError("dpkg install failed", { file: base, detail });
    return { ok: false, error: detail || "Failed to install .deb package" };
  }

  const pkgName = await readDebPackageName(workspacePath);
  const icon = await ensureDesktopIconForDeb(pkgName, base);
  const displayName = icon?.name || pkgName || base.replace(/\.deb$/i, "");
  if (pkgName) {
    await recordWorkspacePackage(pkgName, displayName, "deb");
  }
  logStep("Installed .deb in workspace", { file: base, desktop: icon?.desktopName });
  return {
    ok: true,
    displayName,
    agentId: null,
    kind: "deb",
    desktopIcon: icon?.desktopName || null,
  };
};

const readDebPackageName = async (workspacePath) => {
  const res = await dockerExec(
    ["bash", "-lc", `dpkg-deb -f ${JSON.stringify(workspacePath)} Package 2>/dev/null`],
    { timeoutMs: 15_000 },
  );
  return (res.stdout || "").trim() || null;
};

const recordWorkspacePackage = async (pkg, displayName, kind = "deb") => {
  if (!pkg) return;
  await dockerExec(
    [
      "python3",
      "/opt/bridge/record-workspace-package.py",
      "add",
      pkg,
      displayName || pkg,
      kind,
    ],
    { user: "browser", timeoutMs: 15_000 },
  );
};

const removeWorkspacePackageRecord = async (pkg) => {
  if (!pkg) return;
  await dockerExec(
    ["python3", "/opt/bridge/record-workspace-package.py", "remove", pkg],
    { user: "browser", timeoutMs: 15_000 },
  );
};

/**
 * Copy the package's .desktop launcher onto the XFCE desktop and mark trusted.
 * Electron/Chromium-based apps get --no-sandbox for the container X session.
 */
const ensureDesktopIconForDeb = async (pkgName, debBase) => {
  const script = `
set -e
export HOME=/home/browser
mkdir -p "$HOME/Desktop" "$HOME/.local/share/applications"

PKG=${JSON.stringify(pkgName || "")}
DEB_BASE=${JSON.stringify(debBase || "")}

# Find a real application .desktop from the installed package (skip url-handlers).
SRC=""
if [[ -n "$PKG" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" || ! -f "$f" ]] && continue
    case "$f" in
      *url-handler*) continue ;;
    esac
    if grep -q '^Type=Application' "$f" 2>/dev/null; then
      SRC="$f"
      break
    fi
  done < <(dpkg -L "$PKG" 2>/dev/null | grep '\\.desktop$' || true)
fi

if [[ -z "$SRC" ]]; then
  # Fallback: match by name under applications
  for cand in /usr/share/applications/*.desktop; do
    [[ -f "$cand" ]] || continue
    case "$cand" in *url-handler*) continue ;; esac
    base="$(basename "$cand" .desktop)"
    if [[ -n "$PKG" && "$base" == "$PKG" ]]; then SRC="$cand"; break; fi
  done
fi

if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "NO_DESKTOP"
  exit 0
fi

NAME="$(grep -m1 '^Name=' "$SRC" | sed 's/^Name=//' || true)"
[[ -z "$NAME" ]] && NAME="$PKG"
[[ -z "$NAME" ]] && NAME="\${DEB_BASE%.deb}"
SAFE_NAME="$(echo "$NAME" | tr -cd 'A-Za-z0-9 ._-' | sed 's/  */ /g' | sed 's/^ *//;s/ *$//')"
[[ -z "$SAFE_NAME" ]] && SAFE_NAME="App"
DEST_APP="$HOME/.local/share/applications/onebridge-\${SAFE_NAME// /_}.desktop"
DEST_DESKTOP="$HOME/Desktop/\${SAFE_NAME}.desktop"

# Rewrite Exec for container X; resolve Icon to absolute path; tag for uninstall.
# Emit only the main [Desktop Entry] (drop Actions) so XFCE always shows the icon.
python3 - "$SRC" "$DEST_APP" "$PKG" <<'PY'
import os
import sys
src, dest, pkg = sys.argv[1], sys.argv[2], sys.argv[3]
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
        cmd = line[5:]
        parts = cmd.split()
        if parts:
            bin0 = parts[0]
            rest = [p for p in parts[1:] if not p.startswith("%")]
            flags = []
            low = bin0.lower()
            if any(x in low for x in ("cursor", "chrom", "code", "electron")):
                for f in ("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"):
                    if f not in rest:
                        flags.append(f)
            # Keep field codes like %F at the end for desktop launchers
            codes = [p for p in parts[1:] if p.startswith("%")]
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
open(dest, "w", encoding="utf-8").write("\\n".join(out) + "\\n")
PY

chmod +x "$DEST_APP"
# Desktop link as Application (XFCE does not support application:// links)
cp -f "$DEST_APP" "$DEST_DESKTOP"
chmod +x "$DEST_DESKTOP"
if command -v gio >/dev/null 2>&1; then
  gio set "$DEST_DESKTOP" metadata::trusted true 2>/dev/null || true
fi
chown browser:browser "$DEST_APP" "$DEST_DESKTOP" 2>/dev/null || true
# Force XFCE to pick up the new icon (reload is often not enough)
export DISPLAY=:1
if pgrep -x xfdesktop >/dev/null 2>&1; then
  xfdesktop --reload 2>/dev/null || true
  # Nudge by touching Desktop so the file monitor fires
  touch "$HOME/Desktop" "$DEST_DESKTOP" 2>/dev/null || true
fi
echo "OK|$SAFE_NAME|$DEST_DESKTOP"
`;

  const res = await dockerExec(["bash", "-lc", script], {
    user: "browser",
    timeoutMs: 30_000,
  });
  const line = (res.stdout || "").trim().split("\n").pop() || "";
  if (!line.startsWith("OK|")) {
    logError("Desktop icon creation failed", {
      pkg: pkgName,
      code: res.code,
      stdout: (res.stdout || "").trim().slice(-400),
      stderr: (res.stderr || "").trim().slice(-400),
    });
    return null;
  }
  const parts = line.split("|");
  return {
    name: parts[1] || pkgName || debBase,
    desktopName: parts[1] || null,
    path: parts[2] || null,
  };
};

const installAppImageInWorkspace = async (workspacePath, base) => {
  logStep("Installing AppImage inside workspace", { path: workspacePath });
  const dest = `/home/browser/Applications/${base}`;
  const name = base.replace(/\.appimage$/i, "");
  const res = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "set -e",
        "mkdir -p /home/browser/Applications /home/browser/Desktop /home/browser/.local/share/applications",
        `cp -f ${JSON.stringify(workspacePath)} ${JSON.stringify(dest)}`,
        `chmod +x ${JSON.stringify(dest)}`,
        "chown -R browser:browser /home/browser/Applications",
        `cat > "/home/browser/.local/share/applications/${name}.desktop" <<EOF`,
        "[Desktop Entry]",
        "Version=1.0",
        "Type=Application",
        `Name=${name}`,
        `Exec=${dest} --no-sandbox`,
        "Icon=application-x-executable",
        "Terminal=false",
        "Categories=Utility;",
        `X-OneBridge-Package=appimage:${name}`,
        "EOF",
        `cp -f "/home/browser/.local/share/applications/${name}.desktop" "/home/browser/Desktop/${name}.desktop"`,
        `chmod +x "/home/browser/Desktop/${name}.desktop"`,
        `gio set "/home/browser/Desktop/${name}.desktop" metadata::trusted true 2>/dev/null || true`,
        "chown browser:browser /home/browser/Desktop/*.desktop /home/browser/.local/share/applications/*.desktop 2>/dev/null || true",
      ].join("\n"),
    ],
    { user: "root", timeoutMs: 120_000 },
  );
  if (res.code !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || "AppImage install failed").trim().slice(-500),
    };
  }
  await recordWorkspacePackage(`appimage:${name}`, name, "appimage");
  return {
    ok: true,
    displayName: name,
    agentId: null,
    kind: "appimage",
    path: dest,
    desktopIcon: name,
  };
};

/** List apps the Install Assistant placed on the desktop (uninstallable). */
export const listWorkspaceInstalledApps = async () => {
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running", apps: [] };
  }
  const res = await dockerExec(["python3", "/opt/bridge/list-workspace-apps.py"], {
    user: "browser",
    timeoutMs: 15_000,
  });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || res.stdout || "list failed", apps: [] };
  }
  try {
    const apps = JSON.parse((res.stdout || "").trim() || "[]");
    return { ok: true, apps: Array.isArray(apps) ? apps : [] };
  } catch {
    return { ok: false, error: "Could not parse app list", apps: [] };
  }
};

/** Uninstall a workspace app (dpkg remove + desktop icon cleanup). */
export const uninstallWorkspaceApp = async (packageId) => {
  const pkg = String(packageId || "").trim();
  if (!pkg || pkg.includes("\0") || pkg.includes("..") || pkg.includes("/")) {
    return { ok: false, error: "Invalid package" };
  }
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running" };
  }

  logStep("Uninstalling workspace app", { package: pkg });

  if (pkg.startsWith("appimage:")) {
    const name = pkg.slice("appimage:".length);
    const res = await dockerExec(
      [
        "bash",
        "-lc",
        [
          "set -e",
          `NAME=${JSON.stringify(name)}`,
          'rm -f "/home/browser/Applications/${NAME}.AppImage" "/home/browser/Applications/${NAME}.appimage" "/home/browser/Applications/$NAME" 2>/dev/null || true',
          'rm -f "/home/browser/Desktop/${NAME}.desktop" "/home/browser/.local/share/applications/${NAME}.desktop" 2>/dev/null || true',
          'find /home/browser/Desktop /home/browser/.local/share/applications -maxdepth 1 -name "*.desktop" 2>/dev/null | while read -r f; do grep -q "X-OneBridge-Package=appimage:${NAME}" "$f" 2>/dev/null && rm -f "$f"; done',
          "chown browser:browser /home/browser/Desktop 2>/dev/null || true",
        ].join("\n"),
      ],
      { user: "root", timeoutMs: 60_000 },
    );
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || "Uninstall failed").trim().slice(-500) };
    }
    await removeWorkspacePackageRecord(pkg);
    return { ok: true, displayName: name, package: pkg };
  }

  const res = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "set +e",
        `PKG=${JSON.stringify(pkg)}`,
        "export DEBIAN_FRONTEND=noninteractive",
        'OUT=$(dpkg --purge "$PKG" 2>&1 || apt-get remove -y --purge "$PKG" 2>&1)',
        "CODE=$?",
        'echo "$OUT"',
        "python3 - <<'PY'",
        "import glob, os, sys",
        `pkg = ${JSON.stringify(pkg)}`,
        "for path in glob.glob('/home/browser/Desktop/*.desktop') + glob.glob('/home/browser/.local/share/applications/*.desktop'):",
        "    try:",
        "        text = open(path, encoding='utf-8', errors='replace').read()",
        "    except OSError:",
        "        continue",
        "    if f'X-OneBridge-Package={pkg}' in text or (pkg == 'cursor' and 'Name=Cursor' in text):",
        "        os.remove(path)",
        "        print('removed', path)",
        "PY",
        "chown -R browser:browser /home/browser/Desktop /home/browser/.local/share/applications 2>/dev/null || true",
        "if pgrep -x xfdesktop >/dev/null 2>&1; then xfdesktop --reload 2>/dev/null || true; fi",
        "exit $CODE",
      ].join("\n"),
    ],
    { user: "root", timeoutMs: 180_000 },
  );

  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "Uninstall failed").trim().slice(-800);
    // Still try to remove icons even if purge partially failed
    logError("Uninstall workspace app failed", { package: pkg, detail });
    return { ok: false, error: detail || "Uninstall failed" };
  }

  logStep("Uninstalled workspace app", { package: pkg });
  await removeWorkspacePackageRecord(pkg);
  return { ok: true, displayName: pkg, package: pkg };
};

/** True if filename looks like an installable assistant package. */
export const isAssistantPackageName = (name) => {
  const base = String(name || "").toLowerCase();
  return (
    ARCHIVE_RE.test(base) ||
    base.endsWith(".onebridge")
  );
};
