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
 * (e.g. zenity file picker under /home/browser).
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

/** True if filename looks like an installable assistant package. */
export const isAssistantPackageName = (name) => {
  const base = String(name || "").toLowerCase();
  return (
    ARCHIVE_RE.test(base) ||
    base.endsWith(".onebridge")
  );
};
