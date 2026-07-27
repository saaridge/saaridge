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
      "Return HOST identity (homedir, platform, hostname). Use host paths with other tools — the agent is virtualized onto the host via the bridge.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    kind: "builtin",
  },
  {
    name: "terminal_exec",
    description:
      "Run a shell command on the HOST (not in the container). cwd defaults to the host home directory. Paths are host paths.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on host" },
        cwd: { type: "string", description: "Optional working directory on host (~ allowed)" },
        timeoutMs: { type: "number", description: "Timeout in ms (default 60000)" },
      },
      required: ["command"],
    },
    kind: "builtin",
  },
  {
    name: "read_file",
    description:
      "Read a file from the HOST filesystem (paths like ~/Documents/... resolve on the host).",
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
    description: "Write a file on the HOST filesystem.",
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
    description: "List a directory on the HOST.",
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
    description: "Stat a file or directory on the HOST.",
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
    description: "Delete a file or empty directory on the HOST.",
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
    name: "http_request",
    description:
      "Perform an HTTP(S) request FROM THE HOST network. Prefer this for agent HTTP; container egress is locked to the bridge proxy.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["url"],
    },
    kind: "builtin",
  },
  {
    name: "open_url",
    description:
      "Fetch a URL from the HOST (returns response text). Same network as if the agent ran on the host.",
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
