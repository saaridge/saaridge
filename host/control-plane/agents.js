import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  dockerCp,
  dockerExec,
  ensureContainer,
  containerRunning,
} from "../lib/docker.js";
import { logError, logStep } from "../lib/logger.js";
import {
  createAgentCredential,
  listAgentsPublic,
  removeAgentRecord,
  updateAgentRecord,
  getAgentById,
} from "../lib/auth.js";
import {
  installAgentDesktopIcon,
  removeAgentDesktopIcon,
} from "../lib/agent-icons.js";
import {
  collectInstallCommands,
  defaultInstallCommandsForDir,
  runInstallCommandsWithRetry,
  manualInstallHint,
} from "../lib/agent-setup.js";
import { CONTAINER_NAME, ROOT, STATE_DIR } from "../lib/paths.js";

const repoRoot = ROOT;

const readManifest = (agentDir) => {
  const manifestPath = path.join(agentDir, "agent.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing agent.json in ${agentDir}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
};

/** mcp.json never embeds the raw token — only a credentials file path. */
const writeMcpConfig = (agentDir, agent) => {
  const mcp = {
    mcpServers: {
      "host-bridge": {
        command: "node",
        args: ["/opt/bridge/bridge-mcp-stdio.mjs"],
        env: {
          BRIDGE_URL: "http://host.docker.internal:7331",
          BRIDGE_CREDENTIALS_FILE: `/opt/agents/${agent.id}/.bridge-credentials`,
          AGENT_ID: agent.id,
        },
      },
    },
  };
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(mcp, null, 2));
};

const credentialsPayload = (agent) => {
  const platform = os.platform();
  return JSON.stringify(
    {
      agentId: agent.id,
      token: agent.token,
      localProxyPort: agent.localProxyPort,
      bridgeUrl: "http://host.docker.internal:7331",
      bridgeProxy: "http://host.docker.internal:7332",
      hostMount: "/host",
      hostWorkspace: `/host/workspaces/${agent.id}`,
      hostShared: "/host/shared",
      hostHome: "/host/home",
      hostHostname: os.hostname(),
      hostUsername: (() => {
        try {
          return os.userInfo().username;
        } catch {
          return path.basename(os.homedir());
        }
      })(),
      hostNativeHome: os.homedir(),
      hostPlatform: platform,
      hostArch: os.arch(),
      hostRelease: os.release(),
      hostOsType:
        platform === "darwin"
          ? "Darwin"
          : platform === "win32"
            ? "Windows_NT"
            : "Linux",
    },
    null,
    2,
  );
};

export const listInstalledAgents = () => listAgentsPublic();

export const installAgentFromHostPath = async (hostPath) => {
  const steps = [];
  const push = (message, ok = true, detail) => {
    const step = { ts: new Date().toISOString(), message, ok, detail };
    steps.push(step);
    if (ok) logStep(message, detail || {});
    else logError(message, detail || {});
  };

  let agent = null;

  try {
    const resolved = path.resolve(hostPath);
    if (!fs.existsSync(resolved)) {
      push("Host path does not exist", false, { path: resolved });
      return { ok: false, steps, error: "Host path does not exist" };
    }
    push("Validated host path", true, { path: resolved });

    const manifest = readManifest(resolved);
    const name = manifest.name || path.basename(resolved);
    const agentId = `${name}-${randomUUID().slice(0, 8)}`;

    agent = createAgentCredential({ id: agentId, name });
    push("Issued per-agent token + UID", true, {
      agentId,
      uid: agent.uid,
      username: agent.username,
      tokenFingerprint: agent.token.slice(0, 8),
      hostWorkspace: agent.hostWorkspace,
    });
    push("Provisioned Saaridge workspace", true, {
      path: agent.hostWorkspace,
    });

    writeMcpConfig(resolved, agent);
    push("Wrote mcp.json (credentials file reference only; no shared token)");

    const ensured = await ensureContainer();
    if (!ensured.ok) {
      removeAgentRecord(agentId);
      push("Super-container failed to start", false, { error: ensured.error });
      return { ok: false, steps, error: ensured.error };
    }
    push("Super-container ready");

    // Dedicated Linux user so siblings cannot read this agent's credentials.
    const useradd = await dockerExec([
      "bash",
      "-lc",
      `id ${agent.username} >/dev/null 2>&1 || useradd -u ${agent.uid} -m -s /bin/bash ${agent.username}`,
    ]);
    if (useradd.code !== 0) {
      removeAgentRecord(agentId);
      push("Failed to create agent UID in container", false, {
        detail: useradd.stderr || useradd.stdout,
      });
      return { ok: false, steps, error: useradd.stderr || useradd.stdout };
    }
    push("Created isolated container user", true, {
      username: agent.username,
      uid: agent.uid,
    });

    const workdir = `/opt/agents/${agentId}`;
    await dockerExec(["mkdir", "-p", workdir]);
    const cp = await dockerCp(`${resolved}/.`, `${CONTAINER_NAME}:${workdir}`);
    if (cp.code !== 0) {
      removeAgentRecord(agentId);
      push("docker cp failed", false, { detail: cp.stderr || cp.stdout });
      return { ok: false, steps, error: cp.stderr || cp.stdout };
    }
    push("Installed agent files via host docker cp", true, { dest: workdir });

    // Sync bridge helpers (world-readable code; secrets stay per-agent).
    await dockerExec(["mkdir", "-p", "/opt/bridge"]);
    for (const file of [
      "bridge-mcp-stdio.mjs",
      "auth-proxy.mjs",
      "bridge-browser.sh",
      "agent-env.sh",
      "launch-browser.sh",
    ]) {
      await dockerCp(
        path.join(repoRoot, "container", file),
        `${CONTAINER_NAME}:/opt/bridge/${file}`,
      );
    }
    await dockerExec(["mkdir", "-p", "/opt/bridge/host-bin"]);
    for (const file of [
      "curl",
      "wget",
      "bridge-call",
      "hostpath",
      "uname",
      "hostname",
      "host-shell",
      "bash",
      "sh",
    ]) {
      await dockerCp(
        path.join(repoRoot, "container", "host-bin", file),
        `${CONTAINER_NAME}:/opt/bridge/host-bin/${file}`,
      );
    }
    await dockerExec([
      "bash",
      "-lc",
      "chmod 755 /opt/bridge/bridge-browser.sh /opt/bridge/launch-browser.sh /opt/bridge/agent-env.sh /opt/bridge/host-bin/*; chmod 644 /opt/bridge/*.mjs; rm -f /opt/bridge/token",
    ]);
    push("Synced bridge MCP/proxy helpers + host-bin shims; removed any shared bridge token file");

    // Credentials file: only this UID can read (write via host temp + docker cp).
    const credPath = `${workdir}/.bridge-credentials`;
    const hostCredTmp = path.join(STATE_DIR, `.cred-${agentId}.json`);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(hostCredTmp, credentialsPayload(agent), { mode: 0o600 });
    await dockerCp(hostCredTmp, `${CONTAINER_NAME}:${credPath}`);
    try {
      const { hostIdentityJson, writeWorkspaceOrientation } = await import(
        "../lib/host-identity.js"
      );
      writeWorkspaceOrientation(agentId);
      const idTmp = path.join(STATE_DIR, `.host-id-${agentId}.json`);
      fs.writeFileSync(idTmp, hostIdentityJson(agentId), { mode: 0o644 });
      await dockerCp(idTmp, `${CONTAINER_NAME}:/opt/bridge/host-identity.json`);
      fs.unlinkSync(idTmp);
    } catch {
      /* best-effort */
    }
    fs.unlinkSync(hostCredTmp);
    await dockerExec([
      "bash",
      "-lc",
      `chown -R ${agent.uid}:${agent.uid} ${JSON.stringify(workdir)} && chmod 700 ${JSON.stringify(workdir)} && chmod 600 ${JSON.stringify(credPath)}`,
    ]);
    push("Wrote per-agent credentials (0600) and locked agent directory (0700)");

    // Match OS-specific install commands when listed on a distribution
    let matchedDist = null;
    try {
      const archOut = await dockerExec([
        "bash",
        "-lc",
        `ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) echo arm64;; x86_64|amd64) echo amd64;; *) echo "$ARCH";; esac`,
      ]);
      const arch = (archOut.stdout || "").trim() || "arm64";
      const dists = Array.isArray(manifest.distributions)
        ? manifest.distributions
        : [];
      matchedDist =
        dists.find(
          (d) =>
            String(d.os || "linux").toLowerCase() === "linux" &&
            String(d.arch || "")
              .toLowerCase()
              .replace("aarch64", "arm64")
              .replace("x86_64", "amd64") === arch,
        ) || null;
    } catch {
      matchedDist = null;
    }

    let setupCommands = collectInstallCommands(manifest, matchedDist);
    if (!setupCommands.length) {
      setupCommands = defaultInstallCommandsForDir(resolved, fs);
    }

    // Silent setup inside container (bridge proxy). Retry up to 5 times.
    // Never surface raw install instructions to the end user.
    let setupResult = { ok: true, skipped: true, tries: 0 };
    if (setupCommands.length || manifest?.install?.readyCheck) {
      setupResult = await runInstallCommandsWithRetry({
        agent,
        workdir,
        credPath,
        commands: setupCommands,
        readyCheck: manifest?.install?.readyCheck || matchedDist?.readyCheck,
        maxTries: Math.min(Number(manifest?.install?.retries) || 5, 5),
      });
      if (setupResult.ok) {
        push("Agent setup finished in workspace", true, {
          tries: setupResult.tries,
          skipped: Boolean(setupResult.skipped),
        });
      } else {
        push("Automatic agent setup failed after retries", false, {
          tries: setupResult.tries,
        });
        // Still place files / start what we can, but report manual fallback
        updateAgentRecord(agentId, {
          hostPath: resolved,
          containerPath: workdir,
          manifest,
          status: "setup_failed",
        });
        await dockerCp(
          path.join(repoRoot, "container/open-agent.sh"),
          `${CONTAINER_NAME}:/opt/bridge/open-agent.sh`,
        ).catch(() => {});
        await installAgentDesktopIcon({
          id: agentId,
          name,
          status: "setup_failed",
        }).catch(() => {});
        return {
          ok: false,
          agentId,
          uid: agent.uid,
          tokenFingerprint: agent.token.slice(0, 8),
          steps,
          setupFailed: true,
          manualFallback: true,
          manualHint: manualInstallHint(),
          error: "automatic_setup_failed",
        };
      }
    }

    // Start local auth-proxy (if not already) + agent as the dedicated UID only.
    const startCmd = manifest.startCommand || ["node", "index.js"];
    const runScript = [
      `cd ${JSON.stringify(workdir)}`,
      `export HOME=/home/${agent.username}`,
      `export AGENT_ID=${JSON.stringify(agentId)}`,
      `export BRIDGE_URL=http://host.docker.internal:7331`,
      `export BRIDGE_PROXY_HOST=host.docker.internal`,
      `export BRIDGE_PROXY_PORT=7332`,
      `export HOSTFS_IPC_PORT=7333`,
      `export BRIDGE_CREDENTIALS_FILE=${JSON.stringify(credPath)}`,
      `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
      `export BRIDGE_TOKEN="$(python3 -c 'import json,os; print(json.load(open(os.environ["BRIDGE_CREDENTIALS_FILE"]))["token"])')"`,
      `source /opt/bridge/agent-env.sh`,
      `export BROWSER=/opt/bridge/bridge-browser.sh`,
      `if ! ss -lnt 2>/dev/null | grep -q ":${agent.localProxyPort} "; then nohup node /opt/bridge/auth-proxy.mjs > /tmp/auth-proxy-${agentId}.log 2>&1 & sleep 0.4; fi`,
      `nohup ${startCmd.map((c) => JSON.stringify(c)).join(" ")} > /tmp/agent-${agentId}.log 2>&1 &`,
      `sleep 0.3`,
      `echo $!`,
    ].join("\n");
    const started = await dockerExec(["bash", "-lc", runScript], {
      user: `${agent.uid}:${agent.uid}`,
    });
    if (started.code !== 0) {
      await dockerExec([
        "bash",
        "-lc",
        `pkill -u ${agent.username} || true; rm -rf ${JSON.stringify(workdir)}; userdel -r ${agent.username} 2>/dev/null || true`,
      ]);
      removeAgentRecord(agentId);
      push("Failed to start agent process", false, {
        detail: started.stderr || started.stdout,
      });
      return { ok: false, steps, error: started.stderr || started.stdout };
    }
    const pid = started.stdout.trim().split("\n").pop();
    push("Started auth-proxy + agent under isolated UID", true, { pid });

    await dockerExec([
      "bash",
      "-lc",
      `mkdir -p /var/run/bridge && echo ${agent.localProxyPort} > /var/run/bridge/active-proxy-port && chmod 644 /var/run/bridge/active-proxy-port`,
    ]);

    updateAgentRecord(agentId, {
      hostPath: resolved,
      containerPath: workdir,
      pid,
      manifest,
      status: "running",
    });
    push("Recorded agent in host state (token stored only on host + agent-private file)");

    // Ensure open-agent helper exists, then place desktop icon for the workspace user
    await dockerCp(
      path.join(repoRoot, "container/open-agent.sh"),
      `${CONTAINER_NAME}:/opt/bridge/open-agent.sh`,
    );
    await dockerExec(["chmod", "755", "/opt/bridge/open-agent.sh"]);
    const icon = await installAgentDesktopIcon({
      id: agentId,
      name,
      status: "running",
    });
    if (icon.ok) push("Recorded assistant in workspace");
    else push("Could not add desktop icon", false, { detail: icon.error });

    return {
      ok: true,
      agentId,
      uid: agent.uid,
      tokenFingerprint: agent.token.slice(0, 8),
      steps,
      setupTries: setupResult.tries,
    };
  } catch (err) {
    if (agent?.id) removeAgentRecord(agent.id);
    push("Installation crashed", false, { error: String(err) });
    return { ok: false, steps, error: String(err) };
  }
};

export const uninstallAgent = async (agentId) => {
  const steps = [];
  const push = (message, ok = true, detail) => {
    steps.push({ ts: new Date().toISOString(), message, ok, detail });
    if (ok) logStep(message, detail || {});
    else logError(message, detail || {});
  };

  try {
    const agent = getAgentById(agentId);
    if (!agent) {
      push("Agent not found", false, { agentId });
      return { ok: false, steps, error: "Agent not found" };
    }

    if (await containerRunning()) {
      await removeAgentDesktopIcon(agent);
      await dockerExec([
        "bash",
        "-lc",
        [
          `pkill -u ${agent.username} || true`,
          agent.containerPath
            ? `rm -rf ${JSON.stringify(agent.containerPath)}`
            : "true",
          `userdel -r ${agent.username} 2>/dev/null || userdel ${agent.username} 2>/dev/null || true`,
        ].join("; "),
      ]);
      push("Stopped agent UID processes, removed files + user", true, {
        username: agent.username,
        path: agent.containerPath,
      });
      push("Removed assistant icon from workspace desktop");
    } else {
      push("Container not running; removed host credential state only");
    }

    removeAgentRecord(agentId);
    push("Revoked agent token on host (token no longer accepted by bridge)");
    try {
      const { removeAgentWorkspace } = await import("../bridge/data/paths.js");
      const removed = removeAgentWorkspace(agentId);
      push("Removed host workspace", true, { path: removed });
    } catch (err) {
      push("Host workspace cleanup skipped/failed", false, {
        error: String(err?.message || err),
      });
    }
    return { ok: true, steps };
  } catch (err) {
    push("Uninstall failed", false, { error: String(err) });
    return { ok: false, steps, error: String(err) };
  }
};
