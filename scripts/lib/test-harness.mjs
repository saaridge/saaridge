/**
 * Shared helpers for functional / integration tests.
 */
import { spawnSync } from "node:child_process";

export function createRunner(title) {
  let failed = 0;
  const ok = (name) => console.log(`  OK  ${name}`);
  const fail = (name, err) => {
    failed += 1;
    console.error(`  FAIL ${name}: ${err?.stack || err}`);
  };
  const skip = (name, reason) => console.log(`  SKIP ${name} (${reason})`);
  const section = (name) => console.log(`== ${name} ==`);
  const done = () => {
    console.log(`\nDone. failures=${failed}`);
    return failed;
  };
  return { title, failed, ok, fail, skip, section, done };
}

export function dockerBoxRunning(name = "saaridge-box") {
  const res = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", name],
    { encoding: "utf8" },
  );
  return res.status === 0 && res.stdout.trim() === "true";
}

export function dockerExec(
  script,
  {
    container = "saaridge-box",
    timeoutMs = 30000,
    // Prefer -c: login shells source agent-env and can hang on wedged FUSE.
    login = false,
  } = {},
) {
  const res = spawnSync(
    "docker",
    ["exec", container, "bash", login ? "-lc" : "-c", script],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      (res.stderr || res.stdout || "").trim() || `docker exec exit ${res.status}`,
    );
  }
  return (res.stdout || "").trim();
}

export function dockerCp(localPath, containerPath, container = "saaridge-box") {
  const res = spawnSync(
    "docker",
    ["cp", localPath, `${container}:${containerPath}`],
    { encoding: "utf8", timeout: 20000 },
  );
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || "docker cp failed");
  }
}

export async function waitFor(
  fn,
  { timeoutMs = 20000, intervalMs = 500, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr || new Error(`timed out waiting for ${label}`);
}

export async function fetchOk(url, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function runNodeScript(relPath, { cwd, env = {} } = {}) {
  const res = spawnSync("node", [relPath], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return res;
}
