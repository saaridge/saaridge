import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONTAINER_NAME, ROOT } from "./paths.js";
import {
  IMAGE_NAME as BRAND_IMAGE_NAME,
  LEGACY_CONTAINER_NAMES,
  LEGACY_IMAGE_NAMES,
} from "./brand.js";
import { logError, logStep } from "./logger.js";
import { provisionDesktopSession } from "./desktop.js";
import {
  writeResourcesComposeOverride,
  readResources,
  saveResources,
  RESOURCES_COMPOSE_PATH,
} from "./resources.js";

export const IMAGE_NAME = BRAND_IMAGE_NAME;

/**
 * macOS GUI apps (packaged Electron) get PATH=/usr/bin:/bin:/usr/sbin:/sbin,
 * so bare `docker` fails with ENOENT even when Docker Desktop is installed.
 */
let cachedDockerBin = null;

export const resolveDockerBin = () => {
  if (cachedDockerBin) return cachedDockerBin;
  if (process.env.DOCKER_BIN && fs.existsSync(process.env.DOCKER_BIN)) {
    cachedDockerBin = process.env.DOCKER_BIN;
    return cachedDockerBin;
  }
  const home = process.env.HOME || "";
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    home ? path.join(home, "Applications/Docker.app/Contents/Resources/bin/docker") : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedDockerBin = candidate;
        return cachedDockerBin;
      }
    } catch {
      /* continue */
    }
  }
  cachedDockerBin = "docker";
  return cachedDockerBin;
};

/** PATH extras so docker CLI plugins (compose) and helper tools resolve. */
export const dockerEnv = (extra = {}) => {
  const bin = resolveDockerBin();
  const binDir = path.dirname(bin);
  const extras = [
    binDir,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
  ];
  const parts = String(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")
    .split(":")
    .filter(Boolean);
  for (const dir of extras.reverse()) {
    if (dir && !parts.includes(dir)) parts.unshift(dir);
  }
  return { ...process.env, PATH: parts.join(":"), ...extra };
};

/** Compose project files: base + generated Resources override. */
const composeFileArgs = () => {
  writeResourcesComposeOverride(readResources());
  return [
    "-f",
    path.join(ROOT, "docker-compose.yml"),
    "-f",
    RESOURCES_COMPOSE_PATH,
  ];
};

/** @type {{ phase: string, progress: number, message: string, ok: boolean|null, error: string|null, building: boolean, ready: boolean }} */
let bootStatus = {
  phase: "idle",
  progress: 0,
  message: "Waiting…",
  ok: null,
  error: null,
  building: false,
  ready: false,
};

let ensurePromise = null;

export const getContainerBootStatus = () => ({ ...bootStatus });

const setBoot = (patch) => {
  const progress = Math.max(
    0,
    Math.min(100, Number(patch.progress ?? bootStatus.progress) || 0),
  );
  bootStatus = {
    ...bootStatus,
    ...patch,
    progress: Math.round(progress * 10) / 10,
  };
};

/** Let provisioners (desktop / hostfs ready) push live phase labels to the boot UI. */
export const updateContainerBootStatus = (patch) => setBoot(patch);

export const run = (command, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env || dockerEnv(opts.envExtra || {}),
      shell: opts.shell || false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          stderr += "\n[timeout]";
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      const detail =
        err?.code === "ENOENT"
          ? `Docker CLI not found (${command}). Install Docker Desktop and reopen Saaridge.`
          : String(err);
      resolve({ code: 1, stdout, stderr: stderr + detail });
    });
    if (opts.input != null) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });

export const docker = (args, opts = {}) =>
  run(resolveDockerBin(), args, {
    ...opts,
    env: opts.env || dockerEnv(opts.envExtra || {}),
  });


export const containerRunning = async () => {
  const { stdout } = await docker([
    "inspect",
    "-f",
    "{{.State.Running}}",
    CONTAINER_NAME,
  ]);
  return stdout.trim() === "true";
};

export const imageExists = async (name = IMAGE_NAME) => {
  const { code, stdout } = await docker([
    "image",
    "inspect",
    name,
    "--format",
    "{{.Id}}",
  ]);
  return code === 0 && Boolean(stdout.trim());
};

const containerExists = async (name) => {
  const { code } = await docker(["inspect", "-f", "{{.Id}}", name]);
  return code === 0;
};

/**
 * Stop/remove pre-rename containers that hold ports 6081–6083 and block
 * saaridge-box from starting. Safe to call on every ensure.
 */
export const retireLegacyContainers = async () => {
  for (const name of LEGACY_CONTAINER_NAMES) {
    if (name === CONTAINER_NAME) continue;
    if (!(await containerExists(name))) continue;
    logStep("Retiring legacy workspace container", { name });
    setBoot({
      phase: "migrate",
      progress: Math.max(bootStatus.progress, 6),
      message: `Replacing legacy container (${name})…`,
    });
    await docker(["rm", "-f", name], { timeoutMs: 60_000 });
  }
};

/**
 * If the published tag is missing but an older local image exists, retag it
 * so we do not pull from Docker Hub or force a full rebuild.
 */
const adoptLegacyImage = async () => {
  if (await imageExists(IMAGE_NAME)) return false;
  for (const legacy of LEGACY_IMAGE_NAMES) {
    if (!(await imageExists(legacy))) continue;
    logStep("Retagging legacy workspace image", { from: legacy, to: IMAGE_NAME });
    setBoot({
      phase: "image_ready",
      progress: Math.max(bootStatus.progress, 20),
      message: "Adopting existing workspace image…",
    });
    const tagged = await docker(["tag", legacy, IMAGE_NAME], {
      timeoutMs: 30_000,
    });
    if (tagged.code === 0 && (await imageExists(IMAGE_NAME))) return true;
  }
  return false;
};

/**
 * Ensure workspace image exists.
 * Packaged / pull-preferring installs: Hub pull only (no legacy retag, no local
 * build) so first-run matches what end users experience.
 * Dev checkouts: legacy retag → optional pull → local compose build.
 */
export const ensureImage = async () => {
  if (await imageExists()) {
    logStep("Workspace image already present — skip build", { image: IMAGE_NAME });
    setBoot({
      phase: "image_ready",
      progress: 35,
      message: "Workspace image ready",
      building: false,
    });
    return { ok: true, built: false };
  }

  const preferPull =
    process.env.SAARIDGE_PREFER_PULL === "1" ||
    process.env.SAARIDGE_PACKAGED === "1";

  if (preferPull) {
    logStep("Pulling workspace image", { image: IMAGE_NAME });
    setBoot({
      phase: "pulling",
      progress: 10,
      message: "Downloading workspace image (first launch)…",
      building: true,
      ready: false,
      ok: null,
      error: null,
    });
    const pull = await docker(["pull", IMAGE_NAME], { timeoutMs: 45 * 60_000 });
    if (pull.code === 0 && (await imageExists())) {
      setBoot({
        phase: "image_ready",
        progress: 70,
        message: "Workspace image ready",
        building: false,
      });
      return { ok: true, built: false, pulled: true };
    }
    const detail =
      (pull.stderr || pull.stdout || "").trim() ||
      `Failed to download ${IMAGE_NAME}. Check your network and Docker Hub access.`;
    logError("Workspace image pull failed", { detail: detail.slice(0, 500) });
    setBoot({
      phase: "error",
      progress: 20,
      message: "Could not download workspace image",
      building: false,
      ok: false,
      error: detail.slice(0, 800),
      ready: false,
    });
    return { ok: false, built: false, error: detail.slice(0, 800) };
  }

  if (await adoptLegacyImage()) {
    return { ok: true, built: false, retagged: true };
  }

  logStep("Building workspace image (first run)", { image: IMAGE_NAME });
  setBoot({
    phase: "building",
    progress: 8,
    message: "Building workspace image (first time)…",
    building: true,
    ready: false,
    ok: null,
    error: null,
  });

  let bump = 8;
  const onLine = (chunk) => {
    // docker build streams to stderr; nudge the bar as layers progress
    const lines = String(chunk).split("\n").filter(Boolean);
    for (const line of lines) {
      if (/^#\d+|Step \d+|DONE|exporting|writing image|naming to/i.test(line)) {
        bump = Math.min(68, bump + 1.2);
        setBoot({
          phase: "building",
          progress: bump,
          message: "Building workspace image…",
          building: true,
        });
      }
    }
  };

  const build = await docker(
    ["compose", ...composeFileArgs(), "build", "agent-box"],
    {
      cwd: ROOT,
      timeoutMs: 45 * 60_000,
      onStdout: onLine,
      onStderr: onLine,
    },
  );

  if (build.code !== 0) {
    const detail = build.stderr || build.stdout || "Image build failed";
    logError("Failed to build workspace image", { detail });
    setBoot({
      phase: "error",
      progress: bump,
      message: "Image build failed",
      building: false,
      ok: false,
      error: detail,
      ready: false,
    });
    return { ok: false, built: false, error: detail };
  }

  if (!(await imageExists())) {
    const detail = "Image build finished but image was not found";
    setBoot({
      phase: "error",
      progress: bump,
      message: detail,
      building: false,
      ok: false,
      error: detail,
      ready: false,
    });
    return { ok: false, built: false, error: detail };
  }

  setBoot({
    phase: "image_ready",
    progress: 70,
    message: "Image built — starting workspace…",
    building: false,
  });
  return { ok: true, built: true };
};

const isRecoverableComposeError = (detail) =>
  /manifest unknown|not found|port is already allocated|address already in use|Conflict\. The container name|already in use by container/i.test(
    String(detail || ""),
  );

const startContainer = async ({ forceRecreate = false } = {}) => {
  setBoot({
    phase: "starting",
    progress: Math.max(bootStatus.progress, 72),
    message: forceRecreate
      ? "Recreating workspace with new resources…"
      : "Starting workspace container…",
  });

  const runUp = async (recreate) =>
    docker(
      [
        "compose",
        ...composeFileArgs(),
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        ...(recreate ? ["--force-recreate"] : []),
      ],
      {
        cwd: ROOT,
        timeoutMs: 180_000,
      },
    );

  // Image is ensured separately. --pull never avoids Hub pulls for unpublished tags.
  let up = await runUp(forceRecreate);
  if (up.code !== 0 && isRecoverableComposeError(up.stderr || up.stdout)) {
    logStep("Compose start failed — healing legacy/port conflict and retrying", {
      detail: (up.stderr || up.stdout || "").slice(0, 400),
    });
    setBoot({
      phase: "migrate",
      progress: Math.max(bootStatus.progress, 74),
      message: "Clearing old workspace container and retrying…",
    });
    await retireLegacyContainers();
    const image = await ensureImage();
    if (!image.ok) return image;
    up = await runUp(true);
  }

  if (up.code !== 0) {
    const detail = up.stderr || up.stdout || "Failed to start container";
    logError("Failed to start super-container", { detail });
    setBoot({
      phase: "error",
      message: "Failed to start container",
      ok: false,
      error: detail,
      ready: false,
    });
    return { ok: false, error: detail };
  }

  for (let i = 0; i < 60; i++) {
    if (await containerRunning()) {
      setBoot({
        phase: "container_up",
        progress: 88,
        message: "Container running — preparing desktop…",
      });
      return { ok: true };
    }
    setBoot({
      phase: "starting",
      progress: Math.min(86, 72 + i * 0.4),
      message: "Waiting for container…",
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  const detail = "Container did not become ready in time";
  setBoot({
    phase: "error",
    message: detail,
    ok: false,
    error: detail,
    ready: false,
  });
  return { ok: false, error: detail };
};

const ensureContainerOnce = async ({ forceRecreate = false } = {}) => {
  setBoot({
    phase: "checking",
    progress: 4,
    message: forceRecreate
      ? "Applying resource settings…"
      : "Checking workspace…",
    ok: null,
    error: null,
    ready: false,
    building: false,
  });

  // Clear pre-rename containers so ports/names cannot block saaridge-box.
  await retireLegacyContainers();

  logStep("Checking super-container", { forceRecreate });
  const running = await containerRunning();
  if (running && !forceRecreate) {
    logStep("Super-container already running");
    setBoot({
      phase: "container_up",
      progress: 88,
      message: "Workspace already running — preparing desktop…",
    });
  } else {
    const image = await ensureImage();
    if (!image.ok) {
      return { ok: false, error: image.error };
    }
    logStep("Starting super-container via docker compose", { forceRecreate });
    const started = await startContainer({ forceRecreate });
    if (!started.ok) return started;
    logStep("Super-container started");
  }

  setBoot({
    phase: "desktop",
    progress: 90,
    message: "Preparing desktop session…",
  });
  let desktop;
  try {
    desktop = await provisionDesktopSession();
  } catch (err) {
    const detail = String(err?.message || err);
    logError("Desktop provisioning threw", { detail });
    setBoot({
      phase: "error",
      message: detail,
      ok: false,
      error: detail,
      ready: false,
    });
    return { ok: false, error: detail };
  }
  if (!desktop.ok) {
    const detail = desktop.error || "Desktop provisioning failed";
    setBoot({
      phase: "error",
      message: detail,
      ok: false,
      error: detail,
      ready: false,
    });
    return { ok: false, error: detail };
  }

  setBoot({
    phase: "stream",
    progress: 97,
    message: "Checking desktop stream…",
  });
  // provisionDesktopSession already ensures the stream; re-check for boot UI.
  const { getStreamHealth } = await import("./stream-stack.js");
  const health = await getStreamHealth();
  if (!health.ok) {
    const { ensureStreamStack } = await import("./stream-stack.js");
    setBoot({
      phase: "stream",
      progress: 98,
      message: "Repairing desktop stream…",
    });
    const stream = await ensureStreamStack({ force: true });
    if (!stream.ok) {
      const detail = stream.error || "Desktop stream is not ready";
      setBoot({
        phase: "error",
        message: detail,
        ok: false,
        error: detail,
        ready: false,
      });
      return { ok: false, error: detail };
    }
  }

  logStep("Workspace desktop is ready");
  setBoot({
    phase: "ready",
    progress: 100,
    message: "Workspace ready",
    ok: true,
    error: null,
    ready: true,
    building: false,
  });
  return { ok: true, desktop: true };
};

export const ensureContainer = async (opts = {}) => {
  if (ensurePromise) {
    // If a recreate was requested while boot is in flight, wait then redo.
    if (opts.forceRecreate) {
      await ensurePromise.catch(() => {});
    } else {
      return ensurePromise;
    }
  }
  ensurePromise = ensureContainerOnce(opts).finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
};

/**
 * Save Resources prefs, regenerate compose override, recreate container.
 * Used by Settings → Resources Apply.
 */
export const applyResourcesAndRecreate = async (patch = {}) => {
  const resources = saveResources(patch);
  writeResourcesComposeOverride(resources);
  logStep("Applying workspace resources", resources);
  setBoot({
    phase: "starting",
    progress: 10,
    message: "Applying resource settings (workspace will restart)…",
    ok: null,
    error: null,
    ready: false,
    building: false,
  });
  const result = await ensureContainer({ forceRecreate: true });
  return { ...result, resources };
};

export const dockerExec = (args, opts = {}) =>
  docker(
    ["exec", ...(opts.user ? ["-u", opts.user] : []), CONTAINER_NAME, ...args],
    opts,
  );

export const dockerCp = (src, dest) => docker(["cp", src, dest]);
