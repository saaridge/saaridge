/**
 * Run agent setup/install commands inside the container.
 * Commands are never shown to the end user. Network uses auth-proxy → host bridge.
 */
import { dockerExec } from "./docker.js";
import { logStep, logError } from "./logger.js";

const MAX_TRIES = 5;

/**
 * Collect setup commands from agent.json (and matched distribution).
 * Supported shapes:
 * - installCommands: string[]
 * - install.commands: string[]
 * - distributions[].installCommands
 * - setupCommands: string[]
 */
export const collectInstallCommands = (manifest, distribution = null) => {
  const fromDist = distribution?.installCommands || distribution?.setupCommands;
  const fromRoot =
    manifest?.installCommands ||
    manifest?.setupCommands ||
    manifest?.install?.commands;
  const list = Array.isArray(fromDist)
    ? fromDist
    : Array.isArray(fromRoot)
      ? fromRoot
      : [];
  return list.map((c) => String(c).trim()).filter(Boolean);
};

/**
 * Default dependency install when package.json exists and no explicit commands.
 */
export const defaultInstallCommandsForDir = (hostAgentDir, fs) => {
  const pkg = `${hostAgentDir}/package.json`;
  const mods = `${hostAgentDir}/node_modules`;
  if (fs.existsSync(pkg) && !fs.existsSync(mods)) {
    return ["npm install --omit=dev"];
  }
  return [];
};

const shellQuote = (s) => JSON.stringify(String(s));

/**
 * Ensure per-agent auth-proxy is listening so setup curl/npm use the bridge.
 */
export const ensureAgentAuthProxy = async ({
  agent,
  credPath,
  workdir,
}) => {
  const check = await dockerExec(
    [
      "bash",
      "-lc",
      `ss -lnt 2>/dev/null | grep -q ':${agent.localProxyPort} ' && echo UP || echo DOWN`,
    ],
    { user: `${agent.uid}:${agent.uid}` },
  );
  if ((check.stdout || "").includes("UP")) {
    return { ok: true, already: true };
  }

  const start = await dockerExec(
    [
      "bash",
      "-lc",
      [
        `cd ${shellQuote(workdir)}`,
        `export HOME=/home/${agent.username}`,
        `export AGENT_ID=${shellQuote(agent.id)}`,
        `export BRIDGE_PROXY_HOST=host.docker.internal`,
        `export BRIDGE_PROXY_PORT=7332`,
        `export BRIDGE_CREDENTIALS_FILE=${shellQuote(credPath)}`,
        `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
        `export BRIDGE_TOKEN="$(python3 -c 'import json,os; print(json.load(open(os.environ["BRIDGE_CREDENTIALS_FILE"]))["token"])')"`,
        `source /opt/bridge/agent-env.sh`,
        `nohup node /opt/bridge/auth-proxy.mjs > /tmp/auth-proxy-${agent.id}.log 2>&1 &`,
        `for i in $(seq 1 30); do ss -lnt 2>/dev/null | grep -q ':${agent.localProxyPort} ' && echo UP && exit 0; sleep 0.2; done`,
        `echo DOWN; exit 1`,
      ].join("\n"),
    ],
    { user: `${agent.uid}:${agent.uid}`, timeoutMs: 30_000 },
  );

  return {
    ok: (start.stdout || "").includes("UP"),
    already: false,
    detail: start.stderr || start.stdout,
  };
};

/**
 * Run install commands with retries (max 5). Uses bridge proxy via agent-env.sh.
 * Does not surface command text to callers for user display — only ok/tries/logs path.
 */
export const runInstallCommandsWithRetry = async ({
  agent,
  workdir,
  credPath,
  commands,
  readyCheck,
  maxTries = MAX_TRIES,
}) => {
  const tries = Math.min(Math.max(Number(maxTries) || MAX_TRIES, 1), MAX_TRIES);
  if (!commands.length && !readyCheck) {
    return { ok: true, tries: 0, skipped: true };
  }

  const proxy = await ensureAgentAuthProxy({ agent, credPath, workdir });
  if (!proxy.ok) {
    logError("Auth-proxy failed before agent setup", {
      agentId: agent.id,
      detail: proxy.detail,
    });
    return {
      ok: false,
      tries: 0,
      error: "bridge_proxy_unavailable",
      manualFallback: true,
    };
  }

  const logFile = `/tmp/agent-setup-${agent.id}.log`;
  let lastCode = 1;

  for (let attempt = 1; attempt <= tries; attempt++) {
    logStep("Agent setup attempt", {
      agentId: agent.id,
      attempt,
      tries,
      commandCount: commands.length,
    });

    const script = [
      `cd ${shellQuote(workdir)}`,
      `export HOME=/home/${agent.username}`,
      `export AGENT_ID=${shellQuote(agent.id)}`,
      `export BRIDGE_CREDENTIALS_FILE=${shellQuote(credPath)}`,
      `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
      `export BRIDGE_TOKEN="$(python3 -c 'import json,os; print(json.load(open(os.environ["BRIDGE_CREDENTIALS_FILE"]))["token"])')"`,
      `source /opt/bridge/agent-env.sh`,
      `echo "=== setup attempt ${attempt}/${tries} at $(date -Is) ===" >> ${shellQuote(logFile)}`,
      ...commands.map(
        (cmd) =>
          `( ${cmd} ) >> ${shellQuote(logFile)} 2>&1 || { echo "cmd_failed:$?" >> ${shellQuote(logFile)}; exit 1; }`,
      ),
      readyCheck
        ? `( ${readyCheck} ) >> ${shellQuote(logFile)} 2>&1 || { echo "ready_check_failed" >> ${shellQuote(logFile)}; exit 2; }`
        : `true`,
      `echo SETUP_OK`,
    ].join("\n");

    const result = await dockerExec(["bash", "-lc", script], {
      user: `${agent.uid}:${agent.uid}`,
      timeoutMs: 600_000,
    });
    lastCode = result.code;
    if (result.code === 0 && (result.stdout || "").includes("SETUP_OK")) {
      // Fix ownership after root-ish package managers if any files changed
      await dockerExec([
        "bash",
        "-lc",
        `chown -R ${agent.uid}:${agent.uid} ${shellQuote(workdir)} 2>/dev/null || true`,
      ]);
      return {
        ok: true,
        tries: attempt,
        logFile,
        manualFallback: false,
      };
    }

    logError("Agent setup attempt failed", {
      agentId: agent.id,
      attempt,
      code: result.code,
    });

    if (attempt < tries) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }

  return {
    ok: false,
    tries,
    lastCode,
    logFile,
    error: "setup_failed",
    manualFallback: true,
  };
};

export const manualInstallHint = () =>
  [
    "Automatic setup couldn’t finish after several tries.",
    "Please install this agent yourself:",
    "1. Open the Desktop tab",
    "2. Use the browser and terminal there (internet already goes through Saaridge)",
    "3. Finish whatever setup the agent needs, then come back to Chat if you want help opening it",
  ].join("\n");
