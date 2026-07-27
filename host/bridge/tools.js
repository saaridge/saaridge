import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../lib/docker.js";
import { logBridge } from "../lib/logger.js";
import { getTools, listAllTools } from "../lib/state.js";

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

/** Expand ~ and relative paths against the HOST home — agents should use host paths. */
const resolveHostPath = (input) => {
  if (input == null || input === "") {
    return os.homedir();
  }
  let p = String(input);
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) return path.resolve(os.homedir(), p);
  return path.resolve(p);
};

/**
 * Optional path allowlist on agent.policy.paths (prefix match).
 * Empty / missing = allow all (prototype). Never allow escaping via .. after resolve.
 */
const assertPathAllowed = (agent, hostPath) => {
  const resolved = path.resolve(hostPath);
  const allow = agent?.policy?.paths;
  if (!Array.isArray(allow) || allow.length === 0) return resolved;
  const ok = allow.some((prefix) => {
    const base = path.resolve(resolveHostPath(prefix));
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!ok) {
    throw new Error(`Path denied by policy: ${resolved}`);
  }
  return resolved;
};

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
      return await invokeCustom(tool, args);
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
      return textResult(
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            homedir: os.homedir(),
            hostname: os.hostname(),
            cwd: process.cwd(),
            note:
              "All read_file / write_file / terminal_exec / http_request tools run on this HOST. Container processes have no direct internet; use these tools or HTTP_PROXY.",
          },
          null,
          2,
        ),
      );
    }
    case "terminal_exec": {
      const cwd = args.cwd
        ? assertPathAllowed(agent, resolveHostPath(args.cwd))
        : os.homedir();
      return runShell(args.command, cwd, args.timeoutMs || 60_000);
    }
    case "read_file": {
      const filePath = assertPathAllowed(agent, resolveHostPath(args.path));
      const encoding = args.encoding || "utf8";
      const content = fs.readFileSync(filePath, encoding);
      return textResult(content);
    }
    case "write_file": {
      const filePath = assertPathAllowed(agent, resolveHostPath(args.path));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, args.encoding || "utf8");
      return textResult(`Wrote ${filePath}`);
    }
    case "list_dir": {
      const dirPath = assertPathAllowed(agent, resolveHostPath(args.path));
      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
      return textResult(JSON.stringify(entries, null, 2));
    }
    case "stat_file": {
      const filePath = assertPathAllowed(agent, resolveHostPath(args.path));
      const st = fs.lstatSync(filePath);
      return textResult(
        JSON.stringify(
          {
            path: filePath,
            size: st.size,
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            isSymbolicLink: st.isSymbolicLink(),
            mode: st.mode,
            mtime: st.mtime.toISOString(),
            ctime: st.ctime.toISOString(),
          },
          null,
          2,
        ),
      );
    }
    case "delete_path": {
      const filePath = assertPathAllowed(agent, resolveHostPath(args.path));
      const st = fs.lstatSync(filePath);
      if (st.isDirectory()) fs.rmdirSync(filePath);
      else fs.unlinkSync(filePath);
      return textResult(`Deleted ${filePath}`);
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

const invokeCustom = async (tool, args) => {
  let command = tool.commandTemplate || "";
  for (const [key, value] of Object.entries(args || {})) {
    command = command.replaceAll(`{{${key}}}`, String(value));
  }
  if (!command.trim()) {
    return textResult("Custom tool missing commandTemplate", true);
  }
  return runShell(command, tool.cwd || os.homedir(), tool.timeoutMs || 60_000);
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

export const reloadToolState = () => getTools();
