/**
 * CONSTRAINTS-safe host command execution.
 * Bridge spawns as the host user (no sudo). stdout/stderr mediated via control lib.
 * STATE_DIR is sealed (precheck + Darwin sandbox) — same policy as Data API.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRoots } from "./data/api.js";
import { resolveUnderRoots } from "./data/paths.js";
import { onHostExecCommand, onHostExecOutput } from "./control/lib.js";
import {
  STATE_DIR,
  PRIVATE_STATE_DIR,
  VAULT_KEY_PATH,
} from "../lib/paths.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Privilege / elevation patterns — user-level only. */
const ELEVATION_RE =
  /(?:^|[;&|`\n]|\$\(|\b)(?:sudo|doas|pkexec|su\b|sudoedit|runas\b|osascript\b[^\n]*with\s+administrator\s+privileges)/i;

/** Non-secret session vars allowed into the host child. No SSH agent. */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TERMINFO",
  "COLORTERM",
  "SHELL",
  "DISPLAY",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPATH",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "__CF_USER_TEXT_ENCODING",
]);

/** Classic host credential dirs — denied via precheck + Darwin sandbox. */
export const hostSecretDirPaths = () => {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gcloud"),
    path.join(home, "Library", "Keychains"),
    path.join(home, ".kube"),
    path.join(home, ".docker", "config.json"),
  ];
};

export const assertNoElevation = (command) => {
  const cmd = String(command || "");
  if (ELEVATION_RE.test(cmd)) {
    const err = new Error(
      "host_exec denies elevation (sudo/su/doas/admin). Run as the normal host user only.",
    );
    err.code = "EACCES";
    throw err;
  }
};

const normalizeForMatch = (s) =>
  String(s || "")
    .replace(/\\/g, "/")
    .toLowerCase();

/**
 * Deny command lines that clearly target bridge STATE_DIR or classic secret dirs.
 * Bypassable alone; Darwin sandbox is the hard backstop.
 */
export const assertNoBridgeStateAccess = (command) => {
  const cmd = String(command || "");
  const norm = normalizeForMatch(cmd);
  const roots = [
    STATE_DIR,
    PRIVATE_STATE_DIR,
    VAULT_KEY_PATH,
    ...hostSecretDirPaths(),
  ].map((p) => normalizeForMatch(path.resolve(p)));

  for (const root of roots) {
    if (root && norm.includes(root)) {
      const err = new Error(
        "host_exec denies access to bridge state / host credential dirs. Use mediated Data API paths only.",
      );
      err.code = "EACCES";
      throw err;
    }
  }

  // Common relative mentions of this tree (not unrelated project files).
  if (
    /(?:^|[\s"'`=])(?:\.\/)?state\/private(?:\/|\b)/i.test(cmd) ||
    /state\/private\/vault\.key/i.test(cmd) ||
    /state\/bridge\.token/i.test(cmd) ||
    /state\/mitm-certs/i.test(cmd) ||
    /(?:^|[\s"'`=/])\.ssh(?:\/|\b)/i.test(cmd) ||
    /(?:^|[\s"'`=/])\.gnupg(?:\/|\b)/i.test(cmd) ||
    /(?:^|[\s"'`=/])\.aws(?:\/|\b)/i.test(cmd)
  ) {
    const err = new Error(
      "host_exec denies access to bridge state / host credential dirs. Use mediated Data API paths only.",
    );
    err.code = "EACCES";
    throw err;
  }
};

const buildHostEnv = () => {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] != null && process.env[key] !== "") {
      env[key] = process.env[key];
    }
  }
  env.HOME = os.homedir();
  env.SAARIDGE_HOST_VIA = "host_exec";
  if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
  // Never pass host SSH agent into agent-driven commands.
  delete env.SSH_AUTH_SOCK;
  delete env.SSH_AGENT_PID;
  return env;
};

const sbplDenySubpath = (absPath) => {
  const abs = path.resolve(absPath).replace(/\\/g, "/");
  const escaped = abs.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `(deny file-read* (subpath "${escaped}"))
(deny file-read-metadata (subpath "${escaped}"))
(deny file-write* (subpath "${escaped}"))
(deny file-ioctl (subpath "${escaped}"))`;
};

/**
 * Seatbelt: allow default, deny STATE_DIR + classic credential dirs.
 */
export const buildStateDirSandboxProfile = (stateDir = STATE_DIR) => {
  const denies = [stateDir, ...hostSecretDirPaths()]
    .filter((p) => {
      try {
        return fs.existsSync(p) || p === stateDir;
      } catch {
        return p === stateDir;
      }
    })
    .map(sbplDenySubpath)
    .join("\n");
  return `(version 1)
(allow default)
${denies}
`;
};

const resolveExecCwd = (agent, cwdArg) => {
  const roots = getRoots(agent);
  const allowed = [
    ...(roots.readWrite || []),
    ...(roots.readOnly || []),
  ].filter(Boolean);
  const raw =
    cwdArg == null || cwdArg === ""
      ? roots.workspace || path.join(os.homedir(), "Saaridge")
      : String(cwdArg);
  const { real } = resolveUnderRoots(raw, allowed);
  // Never start a shell with cwd inside bridge state.
  if (
    real === path.resolve(STATE_DIR) ||
    String(real).startsWith(path.resolve(STATE_DIR) + path.sep)
  ) {
    const err = new Error(
      "host_exec denies cwd under bridge state (vault/tokens/MITM).",
    );
    err.code = "EACCES";
    throw err;
  }
  return real;
};

/**
 * @param {object} agent
 * @param {{ command: string, cwd?: string, timeoutMs?: number }} args
 */
export const runHostExec = async (agent, args = {}) => {
  const command = String(args.command || "").trim();
  if (!command) {
    const err = new Error("host_exec requires command");
    err.code = "EINVAL";
    throw err;
  }
  assertNoElevation(command);
  assertNoBridgeStateAccess(command);

  // Mediate the command line (agent → host) before spawn.
  const cmdMed = await onHostExecCommand({ agent, command });
  if (cmdMed?.action === "deny") {
    const err = new Error(cmdMed.reason || "Command denied by policy");
    err.code = "EACCES";
    throw err;
  }
  const mediatedCmd =
    cmdMed?.action === "rewrite" && cmdMed.command != null
      ? String(cmdMed.command)
      : command;
  assertNoElevation(mediatedCmd);
  assertNoBridgeStateAccess(mediatedCmd);

  const cwd = resolveExecCwd(agent, args.cwd);
  const timeoutMs = Math.min(
    Math.max(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );

  const shell = process.env.SHELL || (process.platform === "win32" ? null : "/bin/zsh");
  const hostEnv = buildHostEnv();
  const useDarwinSandbox = process.platform === "darwin";

  let spawnFile = shell || "bash";
  let spawnArgs = ["-lc", mediatedCmd];
  let profilePath = null;

  if (useDarwinSandbox) {
    const profile = buildStateDirSandboxProfile(STATE_DIR);
    profilePath = path.join(
      os.tmpdir(),
      `saaridge-host-exec-${process.pid}-${Date.now()}.sb`,
    );
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    spawnFile = "/usr/bin/sandbox-exec";
    spawnArgs = ["-f", profilePath, shell || "/bin/zsh", "-lc", mediatedCmd];
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const chunksOut = [];
      const chunksErr = [];
      let outLen = 0;
      let errLen = 0;
      let killed = false;

      const child = spawn(spawnFile, spawnArgs, {
        cwd,
        env: hostEnv,
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      const take = (buf, which) => {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (which === "out") {
          if (outLen >= MAX_OUTPUT_BYTES) return;
          const slice = b.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - outLen));
          outLen += slice.length;
          chunksOut.push(slice);
        } else {
          if (errLen >= MAX_OUTPUT_BYTES) return;
          const slice = b.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - errLen));
          errLen += slice.length;
          chunksErr.push(slice);
        }
      };

      child.stdout?.on("data", (d) => take(d, "out"));
      child.stderr?.on("data", (d) => take(d, "err"));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          code: code == null ? (killed ? 124 : 1) : code,
          signal: signal || (killed ? "SIGKILL" : null),
          timedOut: killed,
          stdout: Buffer.concat(chunksOut).toString("utf8"),
          stderr: Buffer.concat(chunksErr).toString("utf8"),
          truncated: outLen >= MAX_OUTPUT_BYTES || errLen >= MAX_OUTPUT_BYTES,
        });
      });
    });

    const mediateStream = async (stream, text) => {
      const med = await onHostExecOutput({
        agent,
        stream,
        text,
        command: mediatedCmd,
      });
      if (med?.action === "deny") {
        return {
          text: "",
          denied: true,
          reason: med.reason || "Output denied by policy",
        };
      }
      if (med?.action === "rewrite") {
        return { text: String(med.data ?? ""), denied: false };
      }
      return { text: String(text ?? ""), denied: false };
    };

    const outM = await mediateStream("stdout", result.stdout);
    const errM = await mediateStream("stderr", result.stderr);

    return {
      cwd,
      command: mediatedCmd,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: outM.text,
      stderr: errM.text,
      stdoutDenied: outM.denied || false,
      stderrDenied: errM.denied || false,
      denyReason: outM.reason || errM.reason || null,
      note: "Ran on host as the normal user; output mediated by Saaridge.",
      sandboxed: useDarwinSandbox,
    };
  } finally {
    if (profilePath) {
      try {
        fs.unlinkSync(profilePath);
      } catch {
        /* ignore */
      }
    }
  }
};
