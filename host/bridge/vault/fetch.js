/**
 * Bridge-owned HTTP fetch for vault-linked (and general mediated) calls.
 * Order: control lib on request (sees vault://) → resolve secrets → fetch →
 * control lib on response (agent never sees raw upstream until after lib).
 */
import * as vault from "./index.js";
import * as control from "../control/index.js";
import { audit } from "../data/audit.js";

const MAX_BODY = 2_000_000;

export const vaultFetch = async (agent, args = {}) => {
  const agentId = agent?.id;
  if (!agentId) {
    const err = new Error("Agent required for vault fetch");
    err.code = "EACCES";
    throw err;
  }

  const method = String(args.method || "GET").toUpperCase();
  let url = String(args.url || "");
  if (!url) {
    const err = new Error("url required");
    err.code = "EINVAL";
    throw err;
  }

  let headers = { ...(args.headers || {}) };
  let body = args.body != null ? String(args.body) : undefined;

  // Attach vaultId as Authorization placeholder so lib sees vault:// form
  if (args.vaultId) {
    const row = vault.get(agentId, args.vaultId);
    if (!row) {
      const err = new Error(`Unknown vault id: ${args.vaultId}`);
      err.code = "ENOENT";
      throw err;
    }
    const headerName = args.authHeader || "Authorization";
    const prefix = args.authPrefix != null ? args.authPrefix : "Bearer ";
    // Prefer vault:// marker for the control library; resolve happens in pipeline
    headers[headerName] = `${prefix}vault://${args.vaultId}`;
    void row; // existence already validated
  }

  const reqProc = await control.onNetRequest({
    agent,
    url,
    method,
    headers,
    body,
  });
  if (reqProc?.action === "deny" || reqProc?.denied) {
    const err = new Error(
      reqProc.denyReason || reqProc.reason || "Request denied by control library",
    );
    err.code = "EACCES";
    throw err;
  }
  url = reqProc.url != null ? reqProc.url : url;
  headers = reqProc.headers || headers;
  if (reqProc.body !== undefined) body = reqProc.body;

  // Audit with pre-secret URL shape when possible (resolved url may contain secrets in query)
  audit({
    plane: "net",
    op: "vault_fetch_request",
    agentId,
    ok: true,
    method,
    url: String(args.url || ""),
    vaultId: args.vaultId || null,
    vaultResolved: !!reqProc.vaultResolved,
  });

  const res = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });

  const ctype = res.headers.get("content-type") || "";
  let resBody;
  if (/image\/|video\/|audio\/|octet-stream|font\/|wasm/i.test(ctype)) {
    const buf = Buffer.from(await res.arrayBuffer());
    resBody = `<${ctype} ${buf.length} bytes>`;
  } else if (/text\/event-stream/i.test(ctype) && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const parts = [];
    const resHeaders = Object.fromEntries(res.headers.entries());
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, idx + 2);
        pending = pending.slice(idx + 2);
        const chunkProc = await control.onNetResponse({
          agent,
          url: String(args.url || url),
          method,
          status: res.status,
          headers: resHeaders,
          body: event,
        });
        if (chunkProc?.action === "deny" || chunkProc?.denied) continue;
        parts.push(
          chunkProc?.action === "rewrite" && chunkProc.body != null
            ? String(chunkProc.body)
            : event,
        );
      }
      if (parts.join("").length > MAX_BODY) break;
    }
    if (pending) {
      const chunkProc = await control.onNetResponse({
        agent,
        url: String(args.url || url),
        method,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: pending,
      });
      if (chunkProc?.action !== "deny" && !chunkProc?.denied) {
        parts.push(
          chunkProc?.action === "rewrite" && chunkProc.body != null
            ? String(chunkProc.body)
            : pending,
        );
      }
    }
    resBody = parts.join("");
    if (resBody.length > MAX_BODY) {
      resBody = resBody.slice(0, MAX_BODY) + "\n…[truncated]";
    }
    const outHeaders = Object.fromEntries(res.headers.entries());
    audit({
      plane: "net",
      op: "vault_fetch_response",
      agentId,
      ok: res.status < 400,
      method,
      url: String(args.url || ""),
      status: res.status,
      bytes: String(resBody || "").length,
      streaming: true,
    });
    return {
      status: res.status,
      headers: outHeaders,
      body: resBody,
      via: "bridge-vault-fetch",
      vaultId: args.vaultId || null,
      streaming: true,
    };
  } else {
    resBody = await res.text();
    if (resBody.length > MAX_BODY) {
      resBody = resBody.slice(0, MAX_BODY) + "\n…[truncated]";
    }
  }

  const resHeaders = Object.fromEntries(res.headers.entries());
  const resProc = await control.onNetResponse({
    agent,
    url: String(args.url || url),
    method,
    status: res.status,
    headers: resHeaders,
    body: resBody,
  });
  if (resProc?.action === "deny" || resProc?.denied) {
    const err = new Error(
      resProc.denyReason || resProc.reason || "Response denied by control library",
    );
    err.code = "EACCES";
    throw err;
  }
  let outBody = resBody;
  let outHeaders = resHeaders;
  if (resProc?.action === "rewrite") {
    outBody = resProc.body ?? resBody;
    if (resProc.headers) outHeaders = resProc.headers;
  }

  audit({
    plane: "net",
    op: "vault_fetch_response",
    agentId,
    ok: res.status < 400,
    method,
    url: String(args.url || ""),
    status: res.status,
    bytes: String(outBody || "").length,
  });

  return {
    status: res.status,
    headers: outHeaders,
    body: outBody,
    via: "bridge-vault-fetch",
    vaultId: args.vaultId || null,
  };
};
