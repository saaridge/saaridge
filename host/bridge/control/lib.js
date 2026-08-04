/**
 * OneBridge control library — THE place to exercise host + network data control.
 *
 * Content policies run locally via PolicyEngine.
 * Return:
 *   { action: "allow", data? | body?, headers?, entries? }
 *   { action: "rewrite", data? | body?, headers?, entries? }
 *   { action: "deny", reason? }
 */
import {
  mediateContent,
  getPolicyMode,
  isPolicyActiveForAgent,
  getEnabledCategories,
} from "../../lib/ai-policy.js";
import { pathLooksSensitive } from "./detect/rules.js";
import { sensitiveNameAction } from "./policies/catalog.js";

const agentIdOf = (agent) =>
  String(agent?.id || agent?.agentId || "unknown");

const runTextPolicy = async ({
  agent,
  channel,
  direction,
  path: filePath,
  url,
  method,
  headers,
  data,
  meta,
}) => {
  try {
    return await mediateContent({
      agentId: agentIdOf(agent),
      channel,
      direction,
      path: filePath,
      url,
      method,
      headers,
      data,
      meta,
    });
  } catch (err) {
    return {
      action: "deny",
      reason: err?.message || "Policy engine error",
    };
  }
};

/** Host file read — `data` is Buffer or string. Listings never hit this. */
export async function onFsRead({ agent, path: filePath, data }) {
  const agentId = agentIdOf(agent);
  if (isPolicyActiveForAgent(agentId, "hide-sensitive-files")) {
    const mode = getPolicyMode("hide-sensitive-files");
    const cats = new Set(getEnabledCategories("hide-sensitive-files"));
    if (mode !== "allow" && pathLooksSensitive(filePath, cats)) {
      if (mode === "block") {
        return {
          action: "deny",
          reason: "Blocked by Hide Sensitive Files",
        };
      }
      // redact — placeholder instead of file contents
      return { action: "rewrite", data: "[hidden-file]" };
    }
  }

  return runTextPolicy({
    agent,
    channel: "fs",
    direction: "ingress",
    path: filePath,
    data,
  });
}

/** Host file write — runs before bytes hit disk. */
export async function onFsWrite({ agent, path: filePath, data }) {
  return runTextPolicy({
    agent,
    channel: "fs",
    direction: "egress",
    path: filePath,
    data,
  });
}

/**
 * Host directory listing — `entries` is [{ name, ... }].
 * Return rewrite with a filtered/renamed entries array to hide paths.
 */
export async function onFsList({ agent, path: dirPath, entries }) {
  const agentId = agentIdOf(agent);
  const list = Array.isArray(entries) ? entries : [];
  if (!isPolicyActiveForAgent(agentId, "hide-sensitive-files")) {
    return { action: "allow", entries: list };
  }
  const mode = getPolicyMode("hide-sensitive-files");
  if (mode === "allow") {
    return { action: "allow", entries: list };
  }
  const cats = new Set(getEnabledCategories("hide-sensitive-files"));
  let changed = false;
  const next = [];
  for (const e of list) {
    const name = typeof e === "string" ? e : e?.name;
    const decision = sensitiveNameAction({
      name,
      mode,
      enabledCategories: cats,
    });
    if (decision.action === "hide") {
      changed = true;
      continue;
    }
    if (decision.action === "rewrite") {
      changed = true;
      if (typeof e === "string") {
        next.push(decision.name);
      } else {
        next.push({ ...e, name: decision.name });
      }
      continue;
    }
    next.push(e);
  }
  if (changed) {
    return { action: "rewrite", entries: next };
  }
  return { action: "allow", entries: list };
}

/** Outbound HTTP(S) / tool request — may still contain vault:// markers. */
export async function onNetRequest({ agent, url, method, headers, body }) {
  const result = await runTextPolicy({
    agent,
    channel: "net",
    direction: "egress",
    url,
    method,
    headers,
    data: body == null ? "" : body,
  });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason };
  }
  if (result?.action === "rewrite") {
    return {
      action: "rewrite",
      body: result.data,
      headers: result.headers || headers,
    };
  }
  return { action: "allow", body, headers };
}

/** Inbound HTTP(S) / SSE chunk / WS text frame before the agent sees it. */
export async function onNetResponse({
  agent,
  url,
  method,
  status,
  headers,
  body,
}) {
  const result = await runTextPolicy({
    agent,
    channel: "net",
    direction: "ingress",
    url,
    method,
    headers,
    data: body == null ? "" : body,
    meta: { status },
  });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason };
  }
  if (result?.action === "rewrite") {
    return {
      action: "rewrite",
      body: result.data,
      headers: result.headers || headers,
    };
  }
  return { action: "allow", body, headers };
}

/**
 * Host pasteboard text entering the container (agent-visible).
 * Fail-closed callers should treat deny/throw as empty string.
 */
export async function onClipboardIngress({ agent, text }) {
  // Policy engine only accepts known channels (fs/net/…). Treat clipboard as
  // host→agent ingress text on a synthetic fs path.
  return runTextPolicy({
    agent,
    channel: "fs",
    direction: "ingress",
    path: "clipboard://host",
    data: text == null ? "" : text,
  });
}

/**
 * Host command line before spawn (agent → host). May rewrite/deny.
 * @returns {{ action, command?, reason? }}
 */
export async function onHostExecCommand({ agent, command }) {
  const result = await runTextPolicy({
    agent,
    channel: "fs",
    direction: "egress",
    path: "exec://host/command",
    data: command == null ? "" : String(command),
  });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason };
  }
  if (result?.action === "rewrite") {
    return { action: "rewrite", command: result.data };
  }
  return { action: "allow", command };
}

/**
 * Host command stdout/stderr before the agent sees it.
 * @returns {{ action, data?, reason? }}
 */
export async function onHostExecOutput({ agent, stream, text, command }) {
  const which = stream === "stderr" ? "stderr" : "stdout";
  return runTextPolicy({
    agent,
    channel: "fs",
    direction: "ingress",
    path: `exec://host/${which}`,
    data: text == null ? "" : String(text),
    meta: { command: String(command || "").slice(0, 200) },
  });
}
