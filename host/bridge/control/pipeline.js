/**
 * Framework mediation pipeline — always invoked by Data API / MITM / vaultFetch.
 * Calls control/lib.js, then resolves vault:// on outbound net requests.
 */
import * as lib from "./lib.js";
import * as vault from "../vault/index.js";
import { hasVaultRefs, requiresMediate } from "../vault/markers.js";
import {
  shouldProcessFsText,
  shouldProcessNetText,
} from "../transformers/text.js";

export { hasVaultRefs, requiresMediate };

const resolveDeep = (agentId, value) => {
  if (value == null) return value;
  if (typeof value === "string") return vault.resolveVaultRefs(agentId, value);
  return value;
};

const resolveHeaders = (agentId, headers = {}) => {
  const out = { ...headers };
  for (const [k, v] of Object.entries(out)) {
    if (v == null) continue;
    out[k] = vault.resolveVaultRefs(agentId, String(v));
  }
  return out;
};

/** Deny if any vault:// remains after resolve (unknown id). */
export const assertNoUnresolvedVaultRefs = (parts, label = "request") => {
  for (const part of parts) {
    if (hasVaultRefs(part)) {
      const err = new Error(
        `Unresolved vault:// reference in ${label} — unknown or missing vault id`,
      );
      err.code = "EACCES";
      err.denied = true;
      throw err;
    }
  }
};

/**
 * Resolve vault:// in url / headers / body for upstream.
 * Call only AFTER lib.onNetRequest so the library sees redacted markers.
 */
export const resolveVaultForUpstream = (agentId, { url, headers, body }) => {
  const nextUrl = resolveDeep(agentId, url);
  const nextHeaders = resolveHeaders(agentId, headers || {});
  const nextBody = body == null ? body : resolveDeep(agentId, String(body));
  assertNoUnresolvedVaultRefs(
    [nextUrl, nextBody, ...Object.values(nextHeaders)],
    "outbound network",
  );
  return { url: nextUrl, headers: nextHeaders, body: nextBody };
};

export const onFsRead = async ({ agent, path: filePath, data }) => {
  if (!shouldProcessFsText(filePath, data)) {
    return { action: "allow", data };
  }
  const result = await lib.onFsRead({ agent, path: filePath, data });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason || "denied by onFsRead" };
  }
  if (result?.action === "rewrite") {
    return { action: "rewrite", data: result.data ?? data };
  }
  return { action: "allow", data: result?.data ?? data };
};

export const onFsWrite = async ({ agent, path: filePath, data }) => {
  if (!shouldProcessFsText(filePath, data)) {
    return { action: "allow", data };
  }
  const result = await lib.onFsWrite({ agent, path: filePath, data });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason || "denied by onFsWrite" };
  }
  let nextData = result?.data ?? data;
  let action = result?.action === "rewrite" ? "rewrite" : "allow";

  const agentId = agent?.id;
  if (agentId && nextData != null) {
    const blob =
      Buffer.isBuffer(nextData) ? nextData.toString("utf8") : String(nextData);
    if (hasVaultRefs(blob)) {
      try {
        const resolved = resolveDeep(agentId, blob);
        assertNoUnresolvedVaultRefs([resolved], "host file write");
        nextData = Buffer.isBuffer(nextData)
          ? Buffer.from(resolved, "utf8")
          : resolved;
        action = "rewrite";
      } catch (err) {
        if (err?.denied || err?.code === "EACCES") {
          return {
            action: "deny",
            reason: err.message,
          };
        }
        throw err;
      }
    }
  }

  if (action === "rewrite") {
    return { action: "rewrite", data: nextData };
  }
  return { action: "allow", data: nextData };
};

export const onFsList = async ({ agent, path: dirPath, entries }) => {
  const result = await lib.onFsList({
    agent,
    path: dirPath,
    entries: Array.isArray(entries) ? entries : [],
  });
  if (result?.action === "deny") {
    return { action: "deny", reason: result.reason || "denied by onFsList" };
  }
  if (result?.action === "rewrite") {
    return {
      action: "rewrite",
      entries: Array.isArray(result.entries) ? result.entries : entries,
    };
  }
  return {
    action: "allow",
    entries: Array.isArray(result?.entries) ? result.entries : entries,
  };
};

/**
 * Net request: library first (sees vault://), then resolve for upstream.
 * Returns { action, body, headers, url?, denied?, denyReason?, vaultResolved? }
 */
export const onNetRequest = async ({ agent, url, method, headers, body }) => {
  const headerBlob = Object.values(headers || {}).map(String).join("\n");
  const hasVault =
    hasVaultRefs(url) || hasVaultRefs(body) || hasVaultRefs(headerBlob);
  const processText =
    hasVault || shouldProcessNetText(headers || {}, body);
  let nextUrl = url;
  let nextHeaders = { ...(headers || {}) };
  let nextBody = body;

  if (processText) {
    const result = await lib.onNetRequest({
      agent,
      url,
      method,
      headers: nextHeaders,
      body: nextBody,
    });
    if (result?.action === "deny") {
      return {
        action: "deny",
        reason: result.reason || "denied by onNetRequest",
        body: "",
        headers: nextHeaders,
        url: nextUrl,
        denied: true,
        denyReason: result.reason || "denied by onNetRequest",
      };
    }
    if (result?.action === "rewrite") {
      if (result.body != null) nextBody = result.body;
      if (result.headers) nextHeaders = result.headers;
      if (result.url != null) nextUrl = result.url;
    } else {
      if (result?.body != null) nextBody = result.body;
      if (result?.headers) nextHeaders = result.headers;
    }
  }

  // Always resolve vault:// for upstream (library already saw markers)
  const agentId = agent?.id;
  if (agentId) {
    try {
      const resolved = resolveVaultForUpstream(agentId, {
        url: nextUrl,
        headers: nextHeaders,
        body: nextBody,
      });
      const changed =
        resolved.url !== nextUrl ||
        resolved.body !== nextBody ||
        JSON.stringify(resolved.headers) !== JSON.stringify(nextHeaders);
      nextUrl = resolved.url;
      nextHeaders = resolved.headers;
      nextBody = resolved.body;
      return {
        action: changed || processText ? "rewrite" : "allow",
        url: nextUrl,
        headers: nextHeaders,
        body: nextBody,
        vaultResolved: changed,
      };
    } catch (err) {
      if (err?.denied || err?.code === "EACCES") {
        return {
          action: "deny",
          reason: err.message,
          denied: true,
          denyReason: err.message,
          body: "",
          headers: nextHeaders,
          url: nextUrl,
        };
      }
      throw err;
    }
  }

  return {
    action: "allow",
    url: nextUrl,
    headers: nextHeaders,
    body: nextBody,
  };
};

export const onNetResponse = async ({
  agent,
  url,
  method,
  status,
  headers,
  body,
}) => {
  if (!shouldProcessNetText(headers || {}, body)) {
    return { action: "allow", body, headers };
  }
  const result = await lib.onNetResponse({
    agent,
    url,
    method,
    status,
    headers,
    body,
  });
  if (result?.action === "deny") {
    return {
      action: "deny",
      reason: result.reason || "denied by onNetResponse",
      denied: true,
      denyReason: result.reason || "denied by onNetResponse",
      body: "",
      headers,
    };
  }
  if (result?.action === "rewrite") {
    return {
      action: "rewrite",
      body: result.body ?? body,
      headers: result.headers || headers,
    };
  }
  return {
    action: "allow",
    body: result?.body ?? body,
    headers: result?.headers || headers,
  };
};

/**
 * Host clipboard → container (agent-visible). Fail-closed: deny/error → empty text.
 */
export const onClipboardIngress = async ({ agent, text }) => {
  const raw = text == null ? "" : String(text);
  try {
    const result = await lib.onClipboardIngress({ agent, text: raw });
    if (result?.action === "deny") {
      return {
        action: "deny",
        reason: result.reason || "denied by onClipboardIngress",
        text: "",
      };
    }
    if (result?.action === "rewrite") {
      return {
        action: "rewrite",
        text: result.data == null ? "" : String(result.data),
      };
    }
    return { action: "allow", text: raw };
  } catch (err) {
    return {
      action: "deny",
      reason: err?.message || "clipboard_mediate_error",
      text: "",
    };
  }
};
