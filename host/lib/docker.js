import { spawn } from "node:child_process";
import { CONTAINER_NAME, ROOT } from "./paths.js";
import { logError, logStep } from "./logger.js";
import { provisionDesktopSession } from "./desktop.js";

export const IMAGE_NAME = "agent-bridge-box:local";

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

export const run = (command, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
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
      resolve({ code: 1, stdout, stderr: stderr + String(err) });
    });
    if (opts.input != null) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });

export const docker = (args, opts = {}) => run("docker", args, opts);

export const containerRunning = async () => {
  const { stdout } = await docker([
    "inspect",
    "-f",
    "{{.State.Running}}",
    CONTAINER_NAME,
  ]);
  return stdout.trim() === "true";
};

export const imageExists = async () => {
  const { code, stdout } = await docker([
    "image",
    "inspect",
    IMAGE_NAME,
    "--format",
    "{{.Id}}",
  ]);
  return code === 0 && Boolean(stdout.trim());
};

/**
 * Build image only when missing. Never rebuilds an existing local image.
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
    ["compose", "build", "agent-box"],
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

const startContainer = async () => {
  setBoot({
    phase: "starting",
    progress: Math.max(bootStatus.progress, 72),
    message: "Starting workspace container…",
  });

  // Never pass --build: image is ensured separately (and only when missing).
  const up = await docker(["compose", "up", "-d", "--no-build"], {
    cwd: ROOT,
    timeoutMs: 120_000,
  });
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

const ensureContainerOnce = async () => {
  setBoot({
    phase: "checking",
    progress: 4,
    message: "Checking workspace…",
    ok: null,
    error: null,
    ready: false,
    building: false,
  });

  logStep("Checking super-container");
  const running = await containerRunning();
  if (running) {
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
    logStep("Starting super-container via docker compose");
    const started = await startContainer();
    if (!started.ok) return started;
    logStep("Super-container started");
  }

  setBoot({
    phase: "desktop",
    progress: 90,
    message: "Preparing desktop session…",
  });
  const desktop = await provisionDesktopSession();
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

export const ensureContainer = async () => {
  if (ensurePromise) return ensurePromise;
  ensurePromise = ensureContainerOnce().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
};

export const dockerExec = (args, opts = {}) =>
  docker(
    ["exec", ...(opts.user ? ["-u", opts.user] : []), CONTAINER_NAME, ...args],
    opts,
  );

export const dockerCp = (src, dest) => docker(["cp", src, dest]);
