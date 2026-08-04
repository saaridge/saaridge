import fs from "node:fs";
import crypto from "node:crypto";
import { AGENTS_STATE, TOOLS_STATE, TOKEN_FILE, STATE_DIR } from "./paths.js";

fs.mkdirSync(STATE_DIR, { recursive: true });

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const writeJson = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

export const ensureToken = () => {
  if (!fs.existsSync(TOKEN_FILE)) {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString("hex"));
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
};

export const getAgents = () => readJson(AGENTS_STATE, { agents: [] });
export const saveAgents = (data) => writeJson(AGENTS_STATE, data);

export const getTools = () =>
  readJson(TOOLS_STATE, {
    builtinsEnabled: true,
    custom: [],
  });

export const saveTools = (data) => writeJson(TOOLS_STATE, data);

/** Default host tools exposed through the bridge (passthrough prototype).
 * All builtins execute on the HOST — the container is a sandbox; the bridge
 * makes host files + network feel local to the agent via MCP / HTTP_PROXY.
 */
export const BUILTIN_TOOLS = [
  {
    name: "host_info",
    description:
      "REQUIRED FIRST: host OS identity and paths. Then run host commands with host_exec (mediated). You are virtualized on the HOST OS. Prefer host_exec over container shell. MCP file tools accept host paths or /host/.... terminal_exec is disabled.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    kind: "builtin",
  },
  {
    name: "host_exec",
    description:
      "Run a shell command on the HOST as the normal user (no sudo/admin). Bridge owns the process; stdout/stderr are mediated before you see them. cwd must be under allowed OneBridge/host roots (default: workspace). Prefer this for all host commands.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on the host" },
        cwd: {
          type: "string",
          description: "Working directory (host path or /host/...). Default: agent workspace",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in ms (default 30000, max 120000)",
        },
      },
      required: ["command"],
    },
    kind: "builtin",
  },
  {
    name: "terminal_exec",
    description:
      "DISABLED: unmediated host shell. Use host_exec instead (mediated, user-level).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    kind: "builtin",
  },
  {
    name: "read_file",
    description:
      "Read a file via the OneBridge data plane (virtualized host view). Paths under /host map to ~/OneBridge or host home.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", description: "Default utf8" },
      },
      required: ["path"],
    },
    kind: "builtin",
  },
  {
    name: "write_file",
    description: "Write a file via the OneBridge data plane (policy + write processors).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
      },
      required: ["path", "content"],
    },
    kind: "builtin",
  },
  {
    name: "list_dir",
    description: "List a directory via the OneBridge data plane.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    kind: "builtin",
  },
  {
    name: "stat_file",
    description: "Stat a file or directory via the OneBridge data plane.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    kind: "builtin",
  },
  {
    name: "delete_path",
    description: "Delete a file or empty directory via the OneBridge data plane.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    kind: "builtin",
  },
  {
    name: "vault_http",
    description:
      "Bridge-owned HTTP(S) call. Optionally attach a vault secret (vaultId). Response text is processed before return — secrets never enter the container.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        vaultId: { type: "string", description: "Vault secret id to attach as auth" },
        authHeader: { type: "string", description: "Header name (default Authorization)" },
        authPrefix: { type: "string", description: "Prefix before secret (default 'Bearer ')" },
      },
      required: ["url"],
    },
    kind: "builtin",
  },
  {
    name: "vault_list",
    description: "List vault secret metadata for this agent (ids/names only — never values).",
    inputSchema: {
      type: "object",
      properties: {},
    },
    kind: "builtin",
  },
  {
    name: "http_request",
    description:
      "Mediated HTTP(S) via the bridge (same processors as vault_http). Prefer vault_http when using host-derived secrets.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        vaultId: { type: "string" },
      },
      required: ["url"],
    },
    kind: "builtin",
  },
  {
    name: "open_url",
    description: "Fetch a URL via the bridge-owned mediated path (processed response).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
    kind: "builtin",
  },
];

export const listAllTools = () => {
  const state = getTools();
  const builtins = state.builtinsEnabled === false ? [] : BUILTIN_TOOLS;
  const custom = (state.custom || []).map((t) => ({
    ...t,
    kind: "custom",
  }));
  return [...builtins, ...custom];
};
