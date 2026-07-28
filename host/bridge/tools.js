import os from "node:os";
import { run } from "../lib/docker.js";
import { logBridge } from "../lib/logger.js";
import { getTools, listAllTools } from "../lib/state.js";
import * as dataApi from "./data/api.js";
import { audit } from "./data/audit.js";
import { getRoots } from "./data/api.js";

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

const runShell = async (command, cwd, timeoutMs = 60_000) => {
  const result = await run("bash", ["-lc", command], {
    cwd: cwd || os.homedir(),
    timeoutMs,
  });
  const body = [
    `exit=${result.code}`,
    "----- stdout -----",
    result.stdout || "",
    "----- stderr -----",
    result.stderr || "",
  ].join("\n");
  return textResult(body, result.code !== 0);
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
      return await invokeCustom(tool, args, agent);
    }
    return await invokeBuiltin(name, args, agent);
  } catch (err) {
    logBridge("tool_error", { tool: name, agentId, error: String(err) });
    return textResult(String(err), true);
  }
};

const invokeBuiltin = async (name, args, agent) => {
  switch (name) {
    case "host_info": {
      const roots = agent ? getRoots(agent) : null;
      return textResult(
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            homedir: os.homedir(),
            hostname: os.hostname(),
            cwd: process.cwd(),
            oneBridge: roots
              ? {
                  workspace: roots.workspace,
                  shared: roots.shared,
                  readWrite: roots.readWrite,
                  readOnly: roots.readOnly,
                }
              : null,
            note:
              "File tools use the OneBridge data plane (~/OneBridge/...). Container apps use /host via FUSE. Network goes through the bridge proxy.",
          },
          null,
          2,
        ),
      );
    }
    case "terminal_exec": {
      // Privileged: cwd must stay under allowlisted OneBridge roots.
      const cwd = dataApi.assertCwdAllowed(
        agent,
        args.cwd || getRoots(agent).workspace,
      );
      audit({
        plane: "data",
        op: "terminal_exec",
        agentId: agent?.id,
        ok: true,
        cwd,
        command: String(args.command || "").slice(0, 500),
      });
      return runShell(args.command, cwd, args.timeoutMs || 60_000);
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
    case "http_request":
    case "open_url": {
      assertUrlAllowed(agent, args.url);
      const method = (args.method || "GET").toUpperCase();
      const res = await fetch(args.url, {
        method,
        headers: args.headers || {},
        body: args.body,
      });
      const body = await res.text();
      return textResult(
        JSON.stringify(
          {
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: body.slice(0, 200_000),
            via: "host",
          },
          null,
          2,
        ),
        res.status >= 400,
      );
    }
    default:
      return textResult(`Builtin not implemented: ${name}`, true);
  }
};

const invokeCustom = async (tool, args, agent) => {
  let command = tool.commandTemplate || "";
  for (const [key, value] of Object.entries(args || {})) {
    command = command.replaceAll(`{{${key}}}`, String(value));
  }
  if (!command.trim()) {
    return textResult("Custom tool missing commandTemplate", true);
  }
  const cwd = agent
    ? dataApi.assertCwdAllowed(agent, tool.cwd || getRoots(agent).workspace)
    : tool.cwd || os.homedir();
  return runShell(command, cwd, tool.timeoutMs || 60_000);
};

export const mcpToolList = (agent = null) => {
  let tools = listAllTools();
  if (agent?.policy?.tools && Array.isArray(agent.policy.tools)) {
    const allow = new Set(agent.policy.tools);
    tools = tools.filter((t) => allow.has(t.name));
  }
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
