import os from "node:os";
import { logBridge } from "../lib/logger.js";
import { getTools, listAllTools } from "../lib/state.js";
import * as dataApi from "./data/api.js";
import { audit } from "./data/audit.js";
import { getRoots } from "./data/api.js";
import * as vault from "./vault/index.js";
import { vaultFetch } from "./vault/fetch.js";

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

/**
 * Optional URL allowlist on agent.policy.urls (prefix / host match).
 */
const assertUrlAllowed = (agent, url) => {
  const allow = agent?.policy?.urls;
  if (!Array.isArray(allow) || allow.length === 0) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  const ok = allow.some((rule) => {
    const r = String(rule);
    if (r.startsWith("http://") || r.startsWith("https://")) {
      return url.startsWith(r);
    }
    return parsed.hostname === r || parsed.hostname.endsWith(`.${r}`);
  });
  if (!ok) {
    throw new Error(`URL denied by policy: ${url}`);
  }
};

export const invokeTool = async (name, args = {}, meta = {}) => {
  const agent = meta.agent || null;
  const agentId = agent?.id || meta.agentId || null;
  logBridge("tool_invoke", {
    tool: name,
    agentId,
    argsPreview: JSON.stringify(args).slice(0, 500),
  });

  if (agent?.policy?.tools && Array.isArray(agent.policy.tools)) {
    if (!agent.policy.tools.includes(name)) {
      return textResult(`Tool denied by policy: ${name}`, true);
    }
  }

  const tools = listAllTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return textResult(`Unknown tool: ${name}`, true);
  }

  try {
    if (tool.kind === "custom") {
      audit({
        plane: "data",
        op: "custom_tool_denied",
        agentId,
        ok: false,
        tool: name,
      });
      return textResult(
        "Custom shell tools are disabled. Use file tools and vault_http / http_request (bridge-mediated).",
        true,
      );
    }
    return await invokeBuiltin(name, args, agent);
  } catch (err) {
    logBridge("tool_error", { tool: name, agentId, error: String(err) });
    return textResult(String(err?.message || err), true);
  }
};

const invokeBuiltin = async (name, args, agent) => {
  switch (name) {
    case "host_info": {
      const roots = agent ? getRoots(agent) : null;
      return textResult(
        JSON.stringify(
          {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            homedir: os.homedir(),
            oneBridge: roots
              ? {
                  workspace: roots.workspace,
                  shared: roots.shared,
                  readWrite: roots.readWrite,
                  readOnly: roots.readOnly,
                }
              : null,
            note:
              "File tools use the OneBridge data plane (virtualized). Network: vault_http / http_request via bridge processors. Host shell disabled.",
          },
          null,
          2,
        ),
      );
    }
    case "terminal_exec": {
      audit({
        plane: "data",
        op: "terminal_exec",
        agentId: agent?.id,
        ok: false,
        denied: true,
        command: String(args.command || "").slice(0, 200),
      });
      return textResult(
        "terminal_exec is disabled. Host shell bypasses mediation. Use read_file/write_file/list_dir and vault_http.",
        true,
      );
    }
    case "read_file": {
      const result = await dataApi.read(agent, args.path, {
        encoding: args.encoding === "base64" ? "base64" : "utf8",
        offset: args.offset,
        length: args.length,
      });
      return textResult(result.content);
    }
    case "write_file": {
      const result = await dataApi.write(agent, args.path, args.content, {
        encoding: args.encoding || "utf8",
        truncate: true,
        offset: 0,
      });
      return textResult(`Wrote ${result.path} (${result.bytesWritten} bytes)`);
    }
    case "list_dir": {
      const result = await dataApi.list(agent, args.path || getRoots(agent).workspace);
      const entries = result.entries.map((e) => ({
        name: e.name,
        type: e.isDirectory ? "dir" : "file",
      }));
      return textResult(JSON.stringify(entries, null, 2));
    }
    case "stat_file": {
      const info = await dataApi.stat(agent, args.path);
      return textResult(
        JSON.stringify(
          {
            path: info.path,
            size: info.size,
            isFile: info.isFile,
            isDirectory: info.isDirectory,
            isSymbolicLink: info.isSymbolicLink,
            mode: info.mode,
            mtime: new Date(info.mtimeMs).toISOString(),
          },
          null,
          2,
        ),
      );
    }
    case "delete_path": {
      const result = await dataApi.unlink(agent, args.path);
      return textResult(`Deleted ${result.path}`);
    }
    case "vault_list": {
      const rows = vault.listMeta(agent?.id);
      return textResult(JSON.stringify(rows, null, 2));
    }
    case "vault_http":
    case "http_request":
    case "open_url": {
      assertUrlAllowed(agent, args.url);
      const result = await vaultFetch(agent, {
        url: args.url,
        method: args.method || "GET",
        headers: args.headers || {},
        body: args.body,
        vaultId: args.vaultId,
        authHeader: args.authHeader,
        authPrefix: args.authPrefix,
      });
      return textResult(JSON.stringify(result, null, 2), result.status >= 400);
    }
    default:
      return textResult(`Builtin not implemented: ${name}`, true);
  }
};

export const mcpToolList = (agent = null) => {
  let tools = listAllTools();
  if (agent?.policy?.tools && Array.isArray(agent.policy.tools)) {
    const allow = new Set(agent.policy.tools);
    tools = tools.filter((t) => allow.has(t.name));
  }
  tools = tools.filter((t) => t.name !== "terminal_exec");
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || {
      type: "object",
      properties: {},
    },
  }));
};

export { assertUrlAllowed };

export const reloadToolState = () => getTools();
