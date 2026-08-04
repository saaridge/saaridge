import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { URL } from "node:url";
import { resolveAgentFromRequestHeaders } from "../lib/auth.js";
import { logBridge } from "../lib/logger.js";
import { ensureMitmCa, getHostCertificate } from "../lib/mitm-certs.js";
import { HttpMessageTap, logTraffic } from "../lib/traffic-log.js";
import { audit } from "./data/audit.js";
import { sanitizeNetAuditEntry } from "./data/audit-sanitize.js";
import * as control from "./control/index.js";
import { hasVaultRefs, requiresMediate } from "./vault/markers.js";
import {
  shouldProcessNetText,
  isCompressedContent,
  shouldStreamOpaqueBody,
  isOpaqueRpcContentType,
} from "./transformers/text.js";

// Prefer IPv4 — Docker Desktop / some Wi‑Fi paths break IPv6 CONNECT tunnels
// (Chromium shows ERR_TUNNEL_CONNECTION_FAILED).
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// Chromium login flows (Cursor/WorkOS/OAuth) open many parallel CONNECTs and
// keep them alive — 32 was starving authenticator.cursor.sh mid-login.
const PER_AGENT_MAX_SESSIONS = 256;
const agentSessions = new Map(); // agentId -> count

/**
 * Adaptive MITM passthrough (NO static hostname allowlists — see CONSTRAINTS.md).
 * Default is inspect. If the client rejects MITM TLS, or we observe a
 * Cloudflare-style challenge under MITM, mark the registrable domain for
 * temporary blind passthrough so a reload can succeed — without naming sites.
 *
 * Residual: while adaptively blind, vault:// on that domain is not visible on
 * the wire; use vault_http for secretful calls (CONSTRAINTS.md).
 */
const ADAPTIVE_PASSTHROUGH_TTL_MS = 6 * 60 * 60 * 1000;
/** @type {Map<string, { until: number, reason: string, sampleHost: string }>} */
const adaptivePassthroughByBase = new Map();

const MULTI_PART_TLDS = new Set([
  "co.uk",
  "com.au",
  "co.jp",
  "com.br",
  "co.in",
  "com.cn",
]);

/**
 * TTL for adaptive blind. Chromium Root Store / Electron clients often never
 * come to trust a private MITM CA — keep the same long window for UNKNOWN_CA
 * so Node (which *does* trust via NODE_EXTRA_CA_CERTS) is not bounced back
 * onto HTTP/1.1-only MITM every few minutes.
 */
export const adaptiveTtlMsForReason = (_reason) => ADAPTIVE_PASSTHROUGH_TTL_MS;

export const registrableBase = (host) => {
  const h = String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return last2;
};

export const markAdaptivePassthrough = (host, reason) => {
  const base = registrableBase(host);
  if (!base) return;
  const reasonStr = String(reason || "mitm_incompatible");
  const ttlMs = adaptiveTtlMsForReason(reasonStr);
  adaptivePassthroughByBase.set(base, {
    until: Date.now() + ttlMs,
    reason: reasonStr,
    sampleHost: String(host || base),
  });
  logBridge("proxy_adaptive_passthrough", {
    host,
    base,
    reason: reasonStr,
    ttlMs,
  });
};

/** Drop adaptive blind so vault-bearing traffic can stay on MITM/MEDIATE. */
export const clearAdaptivePassthrough = (host, reason) => {
  const base = registrableBase(host);
  if (!base) return;
  if (!adaptivePassthroughByBase.has(base)) return;
  adaptivePassthroughByBase.delete(base);
  logBridge("proxy_adaptive_passthrough_cleared", {
    host,
    base,
    reason: String(reason || "vault_mediate"),
  });
};

const shouldPassthroughMitm = (host) => {
  const base = registrableBase(host);
  const row = adaptivePassthroughByBase.get(base);
  if (!row) return false;
  if (Date.now() > row.until) {
    adaptivePassthroughByBase.delete(base);
    return false;
  }
  return true;
};

/** Heuristic: Cloudflare / bot interstitial under MITM → adapt next CONNECT. */
export const looksLikeMitmBlockingChallenge = (body) => {
  const s = String(body || "").slice(0, 8000);
  if (!s) return false;
  return /just a moment|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|attention required|enable javascript and cookies|turnstile|radar-challenge|cf-turnstile|challenges\.cloudflare\.com/i.test(
    s,
  );
};

/** URL/path signals that MITM is in a bot wall (mark before body arrives). */
export const looksLikeMitmChallengeUrl = (urlOrPath) => {
  const s = String(urlOrPath || "");
  if (!s) return false;
  return /cdn-cgi\/challenge|challenge-platform|\/turnstile\/|challenges\.cloudflare\.com|cf-browser-verification/i.test(
    s,
  );
};

/** Static frontend assets — never UTF-8-decode under MITM (corrupts bundles). */
export const looksLikeStaticAssetUrl = (urlOrPath) => {
  const s = String(urlOrPath || "").split("?")[0];
  if (!s) return false;
  return /\/_next\/static\/|\.js$|\.css$|\.mjs$|\.map$|\.woff2?$|\.ttf$/i.test(s);
};

/**
 * Heuristic: media CDN rejected the MITM upstream TLS client (e.g. video 403).
 * Content/URL/header based — not a hostname allowlist. Marks registrable domain
 * for temporary blind passthrough so the next CONNECT can succeed.
 */
export const looksLikeMitmMediaRejection = (statusCode, headers = {}, req = {}) => {
  const status = Number(statusCode);
  if (status !== 403 && status !== 401) return false;
  const url = String(req.url || req.path || "");
  const reqHeaders = req.headers || {};
  const accept = String(reqHeaders.accept || reqHeaders.Accept || "").toLowerCase();
  const ctype = String(
    headers["content-type"] || headers["Content-Type"] || "",
  ).toLowerCase();
  // Range alone is not enough — that would mark API domains on a ranged 401.
  // Require media-shaped URL or Accept/Content-Type evidence.
  if (/videoplayback|mime=video|mime=audio|itag=\d+|\/video\/|\/audio\//i.test(url)) {
    return true;
  }
  if (/video\/|audio\//i.test(accept)) return true;
  if (/video\/|audio\//i.test(ctype)) return true;
  return false;
};

/** Max compressed body size to gunzip-copy for mediation (allow = original bytes). */
const COMPRESSED_MEDIATE_MAX = 2 * 1024 * 1024;

/**
 * Decode gzip/deflate body for mediation. Returns null if too large or undecodable.
 * @param {Record<string, string>} headers
 * @param {Buffer} bodyBuf
 * @returns {Buffer | null}
 */
export const tryDecodeCompressedBody = (headers, bodyBuf) => {
  if (!Buffer.isBuffer(bodyBuf) || !bodyBuf.length) return null;
  if (bodyBuf.length > COMPRESSED_MEDIATE_MAX) return null;
  const enc = String(
    headers["content-encoding"] || headers["Content-Encoding"] || "",
  ).toLowerCase();
  const magicGzip = bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
  const isGzip = /gzip/.test(enc) || magicGzip;
  const isDeflate = /deflate/.test(enc) && !magicGzip;
  const isBr = /\bbr\b/.test(enc) || enc === "br";
  if (!isGzip && !isDeflate && !magicGzip && !isBr) return null;
  try {
    if (isBr && !magicGzip) return zlib.brotliDecompressSync(bodyBuf);
    if (isGzip || magicGzip) return zlib.gunzipSync(bodyBuf);
    try {
      return zlib.inflateSync(bodyBuf);
    } catch {
      return zlib.inflateRawSync(bodyBuf);
    }
  } catch {
    return null;
  }
};

/**
 * Assemble a chunked transfer body into a single Buffer.
 * Returns null if framing is incomplete or decoded size would exceed maxBytes.
 * `framedBytes` is how many bytes of `chunkedBuf` form a complete chunked body.
 * @param {Buffer} chunkedBuf body only (after headers)
 * @param {number} maxBytes
 * @returns {{ body: Buffer, complete: boolean, framedBytes: number } | null}
 */
export const decodeChunkedBody = (chunkedBuf, maxBytes = COMPRESSED_MEDIATE_MAX) => {
  if (!Buffer.isBuffer(chunkedBuf)) return null;
  const parts = [];
  let offset = 0;
  let total = 0;
  while (offset < chunkedBuf.length) {
    const lineEnd = chunkedBuf.indexOf("\r\n", offset);
    if (lineEnd < 0) return null; // incomplete size line
    const sizeLine = chunkedBuf.slice(offset, lineEnd).toString("latin1").split(";")[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    offset = lineEnd + 2;
    if (size === 0) {
      // Optional trailers then final CRLF
      if (chunkedBuf.slice(offset, offset + 2).toString("latin1") === "\r\n") {
        return {
          body: Buffer.concat(parts),
          complete: true,
          framedBytes: offset + 2,
        };
      }
      const finalBlank = chunkedBuf.indexOf("\r\n\r\n", offset);
      if (finalBlank < 0) return null;
      return {
        body: Buffer.concat(parts),
        complete: true,
        framedBytes: finalBlank + 4,
      };
    }
    total += size;
    if (total > maxBytes) {
      return { body: Buffer.alloc(0), complete: false, overCap: true, framedBytes: 0 };
    }
    if (offset + size + 2 > chunkedBuf.length) return null; // incomplete chunk
    parts.push(chunkedBuf.slice(offset, offset + size));
    offset += size + 2; // data + CRLF
  }
  return null; // ran out without terminal 0 chunk
};

/** Parse CONNECT target; supports host:port and [ipv6]:port. */
const parseConnectTarget = (url) => {
  const raw = String(url || "");
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) {
      const host = raw.slice(1, end);
      const portNum = Number(raw.slice(end + 2) || 443) || 443;
      return { host, portNum };
    }
  }
  const idx = raw.lastIndexOf(":");
  if (idx > 0) {
    return {
      host: raw.slice(0, idx),
      portNum: Number(raw.slice(idx + 1) || 443) || 443,
    };
  }
  return { host: raw, portNum: 443 };
};

/**
 * TCP connect with IPv4-first and IPv6 fallback (avoids stuck tunnels).
 */
const connectTcp = (port, host) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const tryFamily = (family, next) => {
      const socket = net.connect({ port, host, family }, () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        resolve(socket);
      });
      socket.setTimeout(12_000, () => {
        socket.destroy();
        if (!settled) {
          if (next) next();
          else {
            settled = true;
            reject(new Error(`CONNECT timeout ${host}:${port}`));
          }
        }
      });
      socket.on("error", (err) => {
        if (settled) return;
        if (next) next();
        else {
          settled = true;
          reject(err);
        }
      });
    };
    tryFamily(4, () => tryFamily(6, null));
  });

const pipeRaw = (a, b) => {
  // Long-lived HTTP/2 / Connect-RPC streams need low latency and keepalives
  // (enterprise agents; adaptive TUNNEL path — see CONSTRAINTS residual).
  for (const s of [a, b]) {
    try {
      if (typeof s.setNoDelay === "function") s.setNoDelay(true);
      if (typeof s.setKeepAlive === "function") s.setKeepAlive(true, 30_000);
    } catch (_) {}
  }
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    try {
      a.destroy();
    } catch (_) {}
    try {
      b.destroy();
    } catch (_) {}
  };
  a.on("error", close);
  b.on("error", close);
  a.on("close", () => {
    if (!b.destroyed) b.destroy();
  });
  b.on("close", () => {
    if (!a.destroyed) a.destroy();
  });
};

/** Policy URL allowlist (same semantics as MCP http_request). */
export const assertProxyUrlAllowed = (agent, hostOrUrl) => {
  if (agent?.policy?.allowAllProxy === true && !agent?.policy?.urls?.length) {
    // Legacy open proxy when allowAllProxy and no urls list.
    return;
  }
  if (agent?.policy?.allowAllProxy === false && !agent?.policy?.urls?.length) {
    const err = new Error("Proxy denied by policy (allowAllProxy=false)");
    err.code = "EACCES";
    throw err;
  }
  const allow = agent?.policy?.urls;
  if (!Array.isArray(allow) || allow.length === 0) return;

  let hostname = hostOrUrl;
  let full = hostOrUrl;
  try {
    if (String(hostOrUrl).includes("://")) {
      const u = new URL(hostOrUrl);
      hostname = u.hostname;
      full = hostOrUrl;
    } else {
      hostname = String(hostOrUrl).split(":")[0];
      full = `https://${hostOrUrl}`;
    }
  } catch {
    hostname = String(hostOrUrl).split(":")[0];
  }

  const ok = allow.some((rule) => {
    const r = String(rule);
    if (r.startsWith("http://") || r.startsWith("https://")) {
      return full.startsWith(r);
    }
    return hostname === r || hostname.endsWith(`.${r}`);
  });
  if (!ok) {
    const err = new Error(`URL denied by policy: ${hostOrUrl}`);
    err.code = "EACCES";
    throw err;
  }
};

const acquireSession = (agentId) => {
  const id = agentId || "_anon";
  const n = agentSessions.get(id) || 0;
  if (n >= PER_AGENT_MAX_SESSIONS) {
    const err = new Error("Too many concurrent proxy sessions");
    err.code = "EBUSY";
    throw err;
  }
  agentSessions.set(id, n + 1);
};

const releaseSession = (agentId) => {
  const id = agentId || "_anon";
  const n = agentSessions.get(id) || 0;
  if (n <= 1) agentSessions.delete(id);
  else agentSessions.set(id, n - 1);
};

/** Fail-closed result when mediation throws — never pass original body through. */
export const mediationErrorResult = (msg) => ({
  ...msg,
  body: "",
  denied: true,
  denyReason: "mediation_error",
});

/**
 * WS/SSE text mediation (CONSTRAINTS): control.lib only — never resolve vault://
 * on stream bodies. Unresolved markers clear the unit. Errors fail closed (empty)
 * and leave the socket up for the caller.
 *
 * @param {{ agent: object, host?: string, direction: "egress"|"ingress", text: string, channel?: "ws"|"sse" }} opts
 * @returns {Promise<string>}
 */
export const mediateStreamText = async ({
  agent,
  host = "stream",
  direction,
  text,
  channel = "ws",
  /** @internal test-only override of control.lib */
  _lib = null,
}) => {
  const raw = text == null ? "" : String(text);
  if (!raw) return "";

  const headers = {
    "content-type":
      channel === "sse" ? "text/event-stream" : "text/plain",
  };
  const url =
    channel === "sse" ? `https://${host}/` : `wss://${host}/`;
  const logOp =
    channel === "sse" ? "sse_transform_error" : "ws_transform_error";
  const libApi = _lib || control.lib;

  let next = raw;
  try {
    let result;
    if (direction === "egress") {
      result = await libApi.onNetRequest({
        agent,
        url,
        method: channel === "ws" ? "WEBSOCKET" : "POST",
        headers,
        body: next,
      });
    } else {
      result = await libApi.onNetResponse({
        agent,
        url,
        method: channel === "ws" ? "WEBSOCKET" : "GET",
        status: channel === "ws" ? 101 : 200,
        headers,
        body: next,
      });
    }
    if (result?.action === "deny") {
      next = "";
    } else if (result?.action === "rewrite" && result.body != null) {
      next = String(result.body);
    } else if (result?.body != null && result.action === "allow") {
      next = String(result.body);
    }
  } catch (err) {
    logBridge(logOp, {
      error: String(err),
      direction,
      channel,
      denyReason: "mediation_error",
    });
    return "";
  }

  // Never forward unresolved vault:// on streams (no resolve path here).
  if (hasVaultRefs(next)) return "";
  return next;
};

/** Mediation via control pipeline — vault:// resolved after lib.onNetRequest. */
export const transformNetBody = async (agent, direction, msg) => {
  try {
    if (direction === "request") {
      const mediate = requiresMediate({
        url: msg.url,
        headers: msg.headers,
        body: msg.body,
      });
      // Blind adaptive cannot safely carry vault://. Clear the mark so this
      // MITM path can resolve; callers on true TUNNEL never reach here.
      if (mediate && msg.host && shouldPassthroughMitm(msg.host)) {
        clearAdaptivePassthrough(msg.host, "vault_requires_mediate");
      }
      const result = await control.onNetRequest({
        agent,
        url: msg.url,
        method: msg.method,
        headers: msg.headers,
        body: msg.body,
      });
      if (result?.action === "deny" || result?.denied) {
        return {
          ...msg,
          body: "",
          denied: true,
          denyReason: result.denyReason || result.reason,
          hadVault: mediate,
        };
      }
      if (mediate || result?.vaultResolved) {
        clearAdaptivePassthrough(msg.host, "vault_resolved");
      }
      return {
        ...msg,
        url: result.url != null ? result.url : msg.url,
        body: result.body !== undefined ? result.body : msg.body,
        headers: result.headers || msg.headers,
        vaultResolved: !!result.vaultResolved,
        hadVault: mediate || !!result.vaultResolved,
      };
    }
    const result = await control.onNetResponse({
      agent,
      url: msg.url,
      method: msg.method,
      status: msg.statusCode,
      headers: msg.headers,
      body: msg.body,
    });
    if (result?.action === "deny" || result?.denied) {
      return {
        ...msg,
        body: "",
        denied: true,
        denyReason: result.denyReason || result.reason,
      };
    }
    // Adaptive: CF / bot interstitial under MITM → next CONNECT for this domain
    // is blind passthrough (no static URL list). Never after vault-bearing traffic.
    if (
      msg.host &&
      !msg.hadVault &&
      !msg.vaultResolved &&
      (looksLikeMitmChallengeUrl(msg.url || msg.path) ||
        looksLikeMitmBlockingChallenge(
          result?.action === "rewrite" ? result.body : msg.body,
        ))
    ) {
      markAdaptivePassthrough(msg.host, "mitm_blocking_challenge");
    }
    if (result?.action === "rewrite") {
      return {
        ...msg,
        body: result.body,
        headers: result.headers || msg.headers,
      };
    }
    return {
      ...msg,
      body: result?.body !== undefined ? result.body : msg.body,
      headers: result?.headers || msg.headers,
    };
  } catch (err) {
    logBridge("net_transform_error", { error: String(err) });
    return mediationErrorResult(msg);
  }
};

const auditNet = (entry) => {
  // Never persist resolved vault plaintext (CONSTRAINTS §3).
  const safe = sanitizeNetAuditEntry({ plane: "net", ...entry });
  audit(safe);
  logTraffic(safe);
};

const rebuildHttpMessage = (direction, msg, originalHeaders, { force = false } = {}) => {
  const headers = { ...(msg.headers || originalHeaders || {}) };
  const bodyStr = msg.body == null ? "" : String(msg.body);
  const isBinaryPlaceholder =
    typeof bodyStr === "string" &&
    bodyStr.startsWith("<") &&
    bodyStr.includes(" bytes>");

  const shouldRebuild =
    force ||
    msg.vaultResolved ||
    (!isBinaryPlaceholder && shouldProcessNetText(headers, bodyStr));

  if (!shouldRebuild) return null;

  const bodyBuf = Buffer.from(bodyStr, "utf8");
  delete headers["transfer-encoding"];
  delete headers["content-encoding"];
  headers["content-length"] = String(bodyBuf.length);
  const headerLines = Object.entries(headers)
    .filter(([k]) => k && k !== "proxy-authorization" && k !== "proxy-connection")
    .map(([k, v]) => `${k}: ${v}`);
  if (direction === "request") {
    const path = msg.path || "/";
    const start = `${msg.method || "GET"} ${path} HTTP/1.1`;
    return Buffer.concat([
      Buffer.from([start, ...headerLines, "", ""].join("\r\n"), "latin1"),
      bodyBuf,
    ]);
  }
  const start = `HTTP/1.1 ${msg.statusCode || 200} OK`;
  return Buffer.concat([
    Buffer.from([start, ...headerLines, "", ""].join("\r\n"), "latin1"),
    bodyBuf,
  ]);
};

const buildWsTextFrame = (text, { mask } = {}) => {
  const payload = Buffer.from(String(text), "utf8");
  const maskKey = mask ? crypto.randomBytes(4) : null;
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (maskKey) headerLen += 4;
  const out = Buffer.alloc(headerLen + len);
  out[0] = 0x81; // FIN + text
  let offset = 2;
  if (len < 126) {
    out[1] = len | (maskKey ? 0x80 : 0);
  } else if (len <= 0xffff) {
    out[1] = 126 | (maskKey ? 0x80 : 0);
    out.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    out[1] = 127 | (maskKey ? 0x80 : 0);
    out.writeUInt32BE(0, 2);
    out.writeUInt32BE(len, 6);
    offset = 10;
  }
  if (maskKey) {
    maskKey.copy(out, offset);
    offset += 4;
    for (let i = 0; i < len; i++) out[offset + i] = payload[i] ^ maskKey[i % 4];
  } else {
    payload.copy(out, offset);
  }
  return out;
};

/**
 * Process WebSocket text frames (opcode 0x1). Binary frames pass through.
 * Client→server frames are remasked; server→client stay unmasked.
 */
const pipeWebSocketText = (a, b, { agent, host }) => {
  const makeTap = (from, to, label) => {
    let buf = Buffer.alloc(0);
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          // Big lengths: pass through remaining as opaque
          if (!to.destroyed) to.write(buf);
          buf = Buffer.alloc(0);
          return;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;
        const mask = masked ? buf.slice(offset, offset + 4) : null;
        const payloadStart = offset + maskLen;
        const payload = Buffer.from(buf.slice(payloadStart, payloadStart + len));
        const frameEnd = payloadStart + len;
        const fullFrame = buf.slice(0, frameEnd);
        buf = buf.slice(frameEnd);

        if (opcode === 0x1) {
          if (mask) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          }
          const clientToServer = label === "client_to_server";
          let text = await mediateStreamText({
            agent,
            host,
            direction: clientToServer ? "egress" : "ingress",
            text: payload.toString("utf8"),
            channel: "ws",
          });
          if (!to.destroyed) {
            to.write(buildWsTextFrame(text, { mask: clientToServer }));
          }
          auditNet({
            agentId: agent.id,
            op: "ws_text",
            direction: label,
            host,
            body: text.slice(0, 2000),
          });
        } else if (opcode === 0x8) {
          if (!to.destroyed) to.write(fullFrame);
        } else {
          if (!to.destroyed) to.write(fullFrame);
        }
      }
    };
    from.on("data", (chunk) => {
      void onData(chunk);
    });
  };
  makeTap(a, b, "client_to_server");
  makeTap(b, a, "server_to_client");
};

const CHUNKED_BODY_END = Buffer.from("\r\n0\r\n\r\n");

/** Encode one HTTP/1.1 chunked body chunk (hex-size CRLF data CRLF). */
const encodeChunkedPiece = (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return Buffer.concat([
    Buffer.from(`${buf.length.toString(16)}\r\n`, "latin1"),
    buf,
    Buffer.from("\r\n", "latin1"),
  ]);
};

/**
 * MITM pipe: buffer HTTP/1 messages, transform text bodies on the wire,
 * switch to WebSocket / SSE text mediation after headers.
 */
const pipeInspected = (clientTls, upstreamTls, { agent, host }) => {
  let mode = "http"; // http | ws | sse | opaque-body | opaque-until-end | chunked-opaque
  let sawVaultOnConnection = false;
  let clientBuf = Buffer.alloc(0);
  let upstreamBuf = Buffer.alloc(0);
  let opaqueLeft = 0; // remaining body bytes to stream when mode === opaque-body
  let chunkedOpaqueTail = Buffer.alloc(0);
  let chunkedOpaqueDir = "response";
  /** @type {{ url: string, path: string, headers: Record<string, string> }} */
  let lastClientReq = { url: "", path: "", headers: {} };

  const onClientData = (chunk) => {
    if (mode === "chunked-opaque" && chunkedOpaqueDir === "request") {
      if (!upstreamTls.destroyed) upstreamTls.write(chunk);
      const endCheck = Buffer.concat([chunkedOpaqueTail, chunk]);
      if (endCheck.includes(CHUNKED_BODY_END)) mode = "http";
      chunkedOpaqueTail = endCheck.slice(-8);
      return;
    }
    if (mode === "opaque-body" || mode === "opaque-until-end") {
      // Client→server during download (rare); keep connection alive
      if (!upstreamTls.destroyed) upstreamTls.write(chunk);
      return;
    }
    if (mode !== "http") return;
    void forwardHttpSide("request", chunk);
  };
  const onUpstreamData = (chunk) => {
    if (mode === "chunked-opaque" && chunkedOpaqueDir === "response") {
      if (!clientTls.destroyed) clientTls.write(chunk);
      const endCheck = Buffer.concat([chunkedOpaqueTail, chunk]);
      if (endCheck.includes(CHUNKED_BODY_END)) mode = "http";
      chunkedOpaqueTail = endCheck.slice(-8);
      return;
    }
    if (mode === "opaque-until-end") {
      if (!clientTls.destroyed) clientTls.write(chunk);
      return;
    }
    if (mode === "opaque-body") {
      if (!clientTls.destroyed) clientTls.write(chunk);
      opaqueLeft -= chunk.length;
      if (opaqueLeft <= 0) {
        mode = "http";
        opaqueLeft = 0;
      }
      return;
    }
    if (mode !== "http") return;
    void forwardHttpSide("response", chunk);
  };

  const rewriteAcceptEncoding = (buf) => {
    const text = buf.toString("latin1");
    if (!text.includes("\r\n\r\n")) return buf;
    // Prefer identity so MITM can mediate text without corrupting gzip bytes.
    // Opaque/static/media paths still stream compressed bodies when servers insist.
    if (/Accept-Encoding:/i.test(text)) {
      const next = text.replace(
        /Accept-Encoding:[^\r\n]*/i,
        "Accept-Encoding: identity",
      );
      return Buffer.from(next, "latin1");
    }
    // Insert if missing (after first line)
    const idx = text.indexOf("\r\n");
    if (idx < 0) return buf;
    const next =
      text.slice(0, idx + 2) +
      "Accept-Encoding: identity\r\n" +
      text.slice(idx + 2);
    return Buffer.from(next, "latin1");
  };

  const switchToWebSocket = () => {
    mode = "ws";
    clientTls.removeListener("data", onClientData);
    upstreamTls.removeListener("data", onUpstreamData);
    const leftClient = clientBuf;
    const leftUp = upstreamBuf;
    clientBuf = Buffer.alloc(0);
    upstreamBuf = Buffer.alloc(0);
    pipeWebSocketText(clientTls, upstreamTls, { agent, host });
    if (leftClient.length) clientTls.emit("data", leftClient);
    if (leftUp.length) upstreamTls.emit("data", leftUp);
  };

  const switchToSseStream = (direction, headers, headBuf, rest) => {
    mode = "sse";
    clientTls.removeListener("data", onClientData);
    upstreamTls.removeListener("data", onUpstreamData);
    const from = direction === "response" ? upstreamTls : clientTls;
    const to = direction === "response" ? clientTls : upstreamTls;
    // Forward the other direction as opaque for the life of the stream
    const otherFrom = direction === "response" ? clientTls : upstreamTls;
    const otherTo = direction === "response" ? upstreamTls : clientTls;
    otherFrom.on("data", (c) => {
      if (!otherTo.destroyed) otherTo.write(c);
    });

    if (!to.destroyed) to.write(headBuf);
    let buf = rest && rest.length ? Buffer.from(rest) : Buffer.alloc(0);

    const processPayload = async (payload) => {
      if (!payload.length) return Buffer.alloc(0);
      let text = payload.toString("utf8");
      if (!shouldProcessNetText(headers, text)) return payload;
      text = await mediateStreamText({
        agent,
        host,
        direction: direction === "request" ? "egress" : "ingress",
        text,
        channel: "sse",
      });
      auditNet({
        agentId: agent.id,
        op: "sse_chunk",
        direction,
        host,
        body: text.slice(0, 2000),
      });
      return Buffer.from(text, "utf8");
    };

    const drain = async () => {
      while (buf.length >= 3) {
        const lineEnd = buf.indexOf("\r\n");
        if (lineEnd < 0) return;
        const sizeLine = buf.slice(0, lineEnd).toString("latin1").split(";")[0].trim();
        const size = parseInt(sizeLine, 16);
        if (!Number.isFinite(size)) {
          if (!to.destroyed) to.write(buf);
          buf = Buffer.alloc(0);
          return;
        }
        const total = lineEnd + 2 + size + 2;
        if (buf.length < total) return;
        const payload = buf.slice(lineEnd + 2, lineEnd + 2 + size);
        buf = buf.slice(total);
        if (size === 0) {
          if (!to.destroyed) to.write(Buffer.from("0\r\n\r\n", "latin1"));
          return;
        }
        const next = await processPayload(payload);
        if (!to.destroyed) to.write(encodeChunkedPiece(next));
      }
    };

    from.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      void drain();
    });
    if (buf.length) void drain();
  };

  const forwardHttpSide = async (direction, chunk) => {
    if (mode !== "http") return;
    if (direction === "request") {
      chunk = rewriteAcceptEncoding(chunk);
      clientBuf = Buffer.concat([clientBuf, chunk]);
    } else {
      upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
    }
    const raw = direction === "request" ? clientBuf : upstreamBuf;
    const headerEnd = raw.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const head = raw.slice(0, headerEnd).toString("utf8");
    const headers = {};
    for (const line of head.split("\r\n").slice(1)) {
      const c = line.indexOf(":");
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    const cl = headers["content-length"] ? Number(headers["content-length"]) : 0;
    const chunked = (headers["transfer-encoding"] || "").includes("chunked");
    const ctype = headers["content-type"] || "";
    // Only real SSE. Do NOT treat chunked text/html (SPA pages) as event-stream —
    // that path stream-transforms and can yield empty/blank login pages.
    const isSse = /text\/event-stream/i.test(ctype);

    if (direction === "request") {
      const reqLine = head.split("\r\n")[0] || "";
      const reqPath = reqLine.split(" ")[1] || "/";
      lastClientReq = {
        url: `https://${host}${reqPath}`,
        path: reqPath,
        headers: { ...headers },
      };
      // CF challenge under MITM — mark domain so the *next* CONNECT is blind
      // passthrough (runtime content/URL signal — not a site allowlist).
      // Never adapt after vault-bearing traffic on this connection.
      if (
        !sawVaultOnConnection &&
        (looksLikeMitmChallengeUrl(reqPath) ||
          looksLikeMitmChallengeUrl(lastClientReq.url))
      ) {
        markAdaptivePassthrough(host, "mitm_challenge_url");
      }
      // gRPC / Connect-RPC need HTTP/2 (or SSE fallback). Our MITM inspector
      // forces ALPN http/1.1 — opaque RPC under MITM hangs. Adapt + drop so
      // the next CONNECT is a raw TUNNEL (generic content-type signal).
      if (!sawVaultOnConnection && isOpaqueRpcContentType(ctype)) {
        markAdaptivePassthrough(host, "mitm_opaque_rpc");
        logBridge("mitm_opaque_rpc_drop", {
          agentId: agent.id,
          host,
          path: reqPath,
          contentType: ctype,
        });
        try {
          if (!clientTls.destroyed) clientTls.destroy();
        } catch (_) {}
        try {
          if (!upstreamTls.destroyed) upstreamTls.destroy();
        } catch (_) {}
        return;
      }
    } else {
      const statusCode = Number((head.split("\r\n")[0] || "").split(" ")[1]) || 0;
      // Media CDNs often 403 Node's MITM TLS fingerprint — adapt domain (no URL list).
      // Drop this MITM session so the browser opens a fresh CONNECT that hits
      // blind passthrough (same pattern as tlsClientError). Leaving the socket
      // up keeps serving 403s on the inspected connection forever.
      if (
        !sawVaultOnConnection &&
        looksLikeMitmMediaRejection(statusCode, headers, lastClientReq)
      ) {
        markAdaptivePassthrough(host, "mitm_media_reject");
        logBridge("mitm_media_reject_drop", {
          agentId: agent.id,
          host,
          statusCode,
          path: lastClientReq.path,
        });
        try {
          if (!clientTls.destroyed) clientTls.destroy();
        } catch (_) {}
        try {
          if (!upstreamTls.destroyed) upstreamTls.destroy();
        } catch (_) {}
        return;
      }
    }

    // Installers / large binaries / Next static JS+CSS: stream immediately.
    // UTF-8 decoding JS under MITM corrupts bundles and leaves login on "Loading".
    if (
      direction === "response" &&
      !chunked &&
      (shouldStreamOpaqueBody(headers, cl || 0) ||
        looksLikeStaticAssetUrl(lastClientReq.path) ||
        /javascript|ecmascript|css|font\//i.test(ctype))
    ) {
      const headBuf = raw.slice(0, headerEnd + 4);
      const rest = raw.slice(headerEnd + 4);
      upstreamBuf = Buffer.alloc(0);
      const dest = clientTls;
      if (!dest.destroyed) dest.write(headBuf);
      if (rest.length && !dest.destroyed) dest.write(rest);
      auditNet({
        agentId: agent.id,
        op: "net_response",
        host,
        statusCode: Number((head.split("\r\n")[0] || "").split(" ")[1]) || undefined,
        streamingOpaque: true,
        contentType: ctype,
        bytes: cl || rest.length,
      });
      if (cl > 0) {
        opaqueLeft = Math.max(0, cl - rest.length);
        if (opaqueLeft > 0) mode = "opaque-body";
      }
      return;
    }

    if (chunked && isSse && direction === "response") {
      const headBuf = raw.slice(0, headerEnd + 4);
      const rest = raw.slice(headerEnd + 4);
      if (direction === "request") clientBuf = Buffer.alloc(0);
      else upstreamBuf = Buffer.alloc(0);
      switchToSseStream(direction, headers, headBuf, rest);
      return;
    }

    // Gzip/br without Content-Length (common after Accept-Encoding rewrite):
    // must stream byte-for-byte until connection close — treating !cl as
    // bodyless drops the payload and leaves SPAs blank.
    if (
      direction === "response" &&
      !chunked &&
      !cl &&
      isCompressedContent(headers)
    ) {
      const headBuf = raw.slice(0, headerEnd + 4);
      const rest = raw.slice(headerEnd + 4);
      upstreamBuf = Buffer.alloc(0);
      const dest = clientTls;
      if (!dest.destroyed) {
        dest.write(headBuf);
        if (rest.length) dest.write(rest);
      }
      auditNet({
        agentId: agent.id,
        op: "net_response",
        host,
        statusCode: Number((head.split("\r\n")[0] || "").split(" ")[1]) || undefined,
        streamingOpaque: true,
        compressed: true,
        contentType: ctype,
        bytes: rest.length,
      });
      mode = "opaque-until-end";
      return;
    }

    if (chunked) {
      // Buffer small non-SSE chunked bodies, mediate on the wire.
      // Allow = original bytes; rewrite/deny = identity + Content-Length.
      const bodyPart = raw.slice(headerEnd + 4);
      const dest = direction === "request" ? upstreamTls : clientTls;
      const startLine = head.split("\r\n")[0] || "";
      const method = startLine.split(" ")[0];
      const statusMatch = startLine.match(/HTTP\/\d\.\d\s+(\d+)/i);

      // Too large to buffer safely — stream opaque (CONSTRAINTS non-goal),
      // except vault-bearing *requests* which must not reach upstream unresolved.
      if (bodyPart.length > COMPRESSED_MEDIATE_MAX) {
        const headBuf = raw.slice(0, headerEnd + 4);
        const rest = bodyPart;
        const hdrBlob = Object.entries(headers || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
        const vaultOnRequest =
          direction === "request" &&
          (hasVaultRefs(startLine) ||
            hasVaultRefs(hdrBlob) ||
            hasVaultRefs(rest.toString("utf8")));
        if (vaultOnRequest) {
          const reason = "vault:// on over-cap request denied — use vault_http";
          const deny = Buffer.from(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`,
          );
          if (!clientTls.destroyed) clientTls.write(deny);
          clientTls.end();
          upstreamTls.destroy();
          auditNet({
            agentId: agent.id,
            op: "net_request",
            host,
            chunked: true,
            mediated: false,
            overCap: true,
            hadVault: true,
            denied: true,
            error: "vault_over_cap_denied",
          });
          return;
        }
        if (direction === "request") clientBuf = Buffer.alloc(0);
        else upstreamBuf = Buffer.alloc(0);
        if (!dest.destroyed) {
          dest.write(headBuf);
          if (rest.length) dest.write(rest);
        }
        chunkedOpaqueDir = direction;
        chunkedOpaqueTail = rest;
        mode = "chunked-opaque";
        auditNet({
          agentId: agent.id,
          op: direction === "request" ? "net_request" : "net_response",
          host,
          chunked: true,
          mediated: false,
          overCap: true,
          bytes: rest.length,
        });
        return;
      }

      const assembled = decodeChunkedBody(bodyPart, COMPRESSED_MEDIATE_MAX);
      if (assembled?.overCap) {
        const headBuf = raw.slice(0, headerEnd + 4);
        const rest = bodyPart;
        const hdrBlob = Object.entries(headers || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
        const vaultOnRequest =
          direction === "request" &&
          (hasVaultRefs(startLine) ||
            hasVaultRefs(hdrBlob) ||
            hasVaultRefs(rest.toString("utf8")));
        if (vaultOnRequest) {
          const reason = "vault:// on over-cap request denied — use vault_http";
          const deny = Buffer.from(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`,
          );
          if (!clientTls.destroyed) clientTls.write(deny);
          clientTls.end();
          upstreamTls.destroy();
          auditNet({
            agentId: agent.id,
            op: "net_request",
            host,
            chunked: true,
            mediated: false,
            overCap: true,
            hadVault: true,
            denied: true,
            error: "vault_over_cap_denied",
          });
          return;
        }
        if (direction === "request") clientBuf = Buffer.alloc(0);
        else upstreamBuf = Buffer.alloc(0);
        if (!dest.destroyed) {
          dest.write(headBuf);
          if (rest.length) dest.write(rest);
        }
        chunkedOpaqueDir = direction;
        chunkedOpaqueTail = rest;
        mode = "chunked-opaque";
        auditNet({
          agentId: agent.id,
          op: direction === "request" ? "net_request" : "net_response",
          host,
          chunked: true,
          mediated: false,
          overCap: true,
          bytes: rest.length,
        });
        return;
      }
      if (!assembled || !assembled.complete) {
        // Wait for more chunks (same pattern as Content-Length wait).
        return;
      }

      const msgEnd = headerEnd + 4 + assembled.framedBytes;
      const fullMsg = raw.slice(0, msgEnd);
      const restPipe = raw.slice(msgEnd);
      if (direction === "request") clientBuf = restPipe;
      else upstreamBuf = restPipe;

      let bodyBuf = assembled.body;
      const compressed = isCompressedContent(headers);
      let bodyText;
      let mediateHeaders = { ...headers };
      if (compressed) {
        const decoded = tryDecodeCompressedBody(headers, bodyBuf);
        if (!decoded) {
          if (!dest.destroyed) dest.write(fullMsg);
          auditNet({
            agentId: agent.id,
            op: direction === "request" ? "net_request" : "net_response",
            host,
            chunked: true,
            compressed: true,
            mediated: false,
            bytes: bodyBuf.length,
          });
          return;
        }
        bodyText = decoded.toString("utf8");
        delete mediateHeaders["content-encoding"];
        delete mediateHeaders["Content-Encoding"];
      } else {
        bodyText = bodyBuf.toString("utf8");
      }
      delete mediateHeaders["transfer-encoding"];
      delete mediateHeaders["Transfer-Encoding"];
      delete mediateHeaders["content-length"];
      delete mediateHeaders["Content-Length"];

      let msg = {
        agentId: agent.id,
        direction,
        host,
        method: direction === "request" ? method : undefined,
        path: direction === "request" ? startLine.split(" ")[1] : undefined,
        url:
          direction === "request"
            ? `https://${host}${startLine.split(" ")[1] || "/"}`
            : `https://${host}`,
        statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
        headers: mediateHeaders,
        body: bodyText,
      };
      if (direction === "request" && (msg.hadVault || requiresMediate(msg))) {
        sawVaultOnConnection = true;
      }
      msg = await transformNetBody(agent, direction, {
        ...msg,
        hadVault: sawVaultOnConnection || msg.hadVault,
      });
      if (msg.hadVault || msg.vaultResolved) sawVaultOnConnection = true;

      const bodyChanged = String(msg.body ?? "") !== bodyText;
      const needsRewrite = Boolean(msg.denied || msg.vaultResolved || bodyChanged);

      auditNet({
        ...msg,
        op: direction === "request" ? "net_request" : "net_response",
        chunked: true,
        mediated: true,
        rewritten: needsRewrite,
      });

      if (!needsRewrite) {
        if (!dest.destroyed) dest.write(fullMsg);
        return;
      }

      if (msg.denied) {
        if (direction === "request") {
          const reason = String(msg.denyReason || "Forbidden").slice(0, 200);
          const deny = Buffer.from(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`,
          );
          if (!clientTls.destroyed) clientTls.write(deny);
          clientTls.end();
          upstreamTls.destroy();
          return;
        }
        msg.body = "";
      }

      const rebuilt = rebuildHttpMessage(direction, msg, mediateHeaders, {
        force: true,
      });
      if (rebuilt && !dest.destroyed) dest.write(rebuilt);
      else if (!dest.destroyed) dest.write(fullMsg);
      return;
    }

    const bodyStart = headerEnd + 4;
    const totalNeed = bodyStart + (cl || 0);
    const startLine = head.split("\r\n")[0] || "";
    const method = startLine.split(" ")[0];
    const noBodyReq =
      direction === "request" &&
      ["GET", "HEAD", "DELETE", "OPTIONS"].includes(method) &&
      !cl;
    const noBodyRes =
      direction === "response" &&
      (startLine.includes(" 204 ") || startLine.includes(" 304 "));

    if (!noBodyReq && !noBodyRes && raw.length < totalNeed) return;

    const messageBuf =
      noBodyReq || noBodyRes || !cl ? raw.slice(0, bodyStart) : raw.slice(0, totalNeed);
    const rest = raw.slice(messageBuf.length);
    if (direction === "request") clientBuf = rest;
    else upstreamBuf = rest;

    const bodyBuf = messageBuf.slice(bodyStart);
    const statusMatch = startLine.match(/HTTP\/\d\.\d\s+(\d+)/i);
    const compressed =
      isCompressedContent(headers) ||
      (bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b);

    // Compressed: gunzip a copy for mediation; allow keeps original wire bytes.
    if (compressed) {
      const dest = direction === "request" ? upstreamTls : clientTls;
      const decoded = tryDecodeCompressedBody(headers, bodyBuf);
      if (!decoded) {
        if (!dest.destroyed) dest.write(messageBuf);
        auditNet({
          agentId: agent.id,
          op: direction === "request" ? "net_request" : "net_response",
          host,
          method: direction === "request" ? method : undefined,
          statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
          compressed: true,
          mediated: false,
          bytes: bodyBuf.length,
        });
        return;
      }

      const mediateHeaders = { ...headers };
      delete mediateHeaders["content-encoding"];
      delete mediateHeaders["Content-Encoding"];
      delete mediateHeaders["content-length"];
      delete mediateHeaders["Content-Length"];

      const bodyText = decoded.toString("utf8");
      let msg = {
        agentId: agent.id,
        direction,
        host,
        method: direction === "request" ? method : undefined,
        path: direction === "request" ? startLine.split(" ")[1] : undefined,
        url:
          direction === "request"
            ? `https://${host}${startLine.split(" ")[1] || "/"}`
            : `https://${host}`,
        statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
        headers: mediateHeaders,
        body: bodyText,
      };
      if (direction === "request" && (msg.hadVault || requiresMediate(msg))) {
        sawVaultOnConnection = true;
      }
      msg = await transformNetBody(agent, direction, {
        ...msg,
        hadVault: sawVaultOnConnection || msg.hadVault,
      });
      if (msg.hadVault || msg.vaultResolved) sawVaultOnConnection = true;

      const bodyChanged = String(msg.body ?? "") !== bodyText;
      const needsRewrite = Boolean(msg.denied || msg.vaultResolved || bodyChanged);

      auditNet({
        ...msg,
        op: direction === "request" ? "net_request" : "net_response",
        compressed: true,
        mediated: true,
        rewritten: needsRewrite,
      });

      if (!needsRewrite) {
        if (!dest.destroyed) dest.write(messageBuf);
        return;
      }

      if (msg.denied) {
        if (direction === "request") {
          const reason = String(msg.denyReason || "Forbidden").slice(0, 200);
          const deny = Buffer.from(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`,
          );
          if (!clientTls.destroyed) clientTls.write(deny);
          clientTls.end();
          upstreamTls.destroy();
          return;
        }
        msg.body = "";
      }

      const rebuilt = rebuildHttpMessage(direction, msg, mediateHeaders, {
        force: true,
      });
      if (rebuilt && !dest.destroyed) dest.write(rebuilt);
      else if (!dest.destroyed) dest.write(messageBuf);
      return;
    }

    let bodyText = bodyBuf.toString("utf8");
    let msg = {
      agentId: agent.id,
      direction,
      host,
      method: direction === "request" ? method : undefined,
      path: direction === "request" ? startLine.split(" ")[1] : undefined,
      url:
        direction === "request"
          ? `https://${host}${startLine.split(" ")[1] || "/"}`
          : `https://${host}`,
      statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
      headers,
      body: bodyText,
    };
    if (direction === "request" && (msg.hadVault || requiresMediate(msg))) {
      sawVaultOnConnection = true;
    }
    msg = await transformNetBody(agent, direction, {
      ...msg,
      hadVault: sawVaultOnConnection || msg.hadVault,
    });
    if (msg.hadVault || msg.vaultResolved) sawVaultOnConnection = true;
    auditNet({
      ...msg,
      op: direction === "request" ? "net_request" : "net_response",
    });

    const dest = direction === "request" ? upstreamTls : clientTls;
    if (msg.denied) {
      if (direction === "request") {
        const reason = String(msg.denyReason || "Forbidden").slice(0, 200);
        const deny = Buffer.from(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`,
        );
        if (!clientTls.destroyed) clientTls.write(deny);
        clientTls.end();
        upstreamTls.destroy();
        return;
      }
      bodyText = "";
      msg.body = "";
    }

    const rebuilt = rebuildHttpMessage(direction, msg, headers, {
      force: !!msg.vaultResolved,
    });
    if (rebuilt && !dest.destroyed) {
      dest.write(rebuilt);
    } else if (!dest.destroyed) {
      dest.write(messageBuf);
    }

    if (
      direction === "response" &&
      msg.statusCode === 101 &&
      (headers["upgrade"] || "").toLowerCase() === "websocket"
    ) {
      switchToWebSocket();
    }
  };

  clientTls.on("data", onClientData);
  upstreamTls.on("data", onUpstreamData);

  const closeBoth = () => {
    try {
      clientTls.destroy();
    } catch (_) {}
    try {
      upstreamTls.destroy();
    } catch (_) {}
  };
  clientTls.on("error", closeBoth);
  upstreamTls.on("error", closeBoth);
  clientTls.on("end", () => {
    if (mode === "http") upstreamTls.end();
  });
  upstreamTls.on("end", () => {
    if (mode === "opaque-until-end" || mode === "chunked-opaque") mode = "http";
    if (mode === "http") clientTls.end();
  });
  clientTls.on("close", () => {
    if (!upstreamTls.destroyed) upstreamTls.destroy();
  });
  upstreamTls.on("close", () => {
    if (!clientTls.destroyed) clientTls.destroy();
  });
};

/**
 * Inspecting forward proxy for container browsers.
 * HTTPS CONNECT is MITM'd so request/response bodies are logged per agent.
 */
export const startProxy = ({ port = 7332 } = {}) => {
  ensureMitmCa();

  const server = http.createServer((req, res) => {
    const agent = resolveAgentFromRequestHeaders(req.headers);
    if (!agent) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="host-bridge"' });
      res.end("Proxy authentication required");
      return;
    }

    try {
      assertProxyUrlAllowed(agent, req.url);
      acquireSession(agent.id);
    } catch (err) {
      const status = err.code === "EBUSY" ? 429 : 403;
      res.writeHead(status);
      res.end(err.message || "Forbidden");
      auditNet({
        agentId: agent.id,
        op: "net_request",
        ok: false,
        error: err.message,
        url: req.url,
      });
      return;
    }

    let target;
    try {
      target = new URL(req.url);
    } catch {
      releaseSession(agent.id);
      res.writeHead(400);
      res.end("Bad URL");
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const bodyBuf = Buffer.concat(chunks);
      let reqMsg = {
        agentId: agent.id,
        direction: "request",
        host: target.host,
        method: req.method,
        url: req.url,
        path: target.pathname + target.search,
        headers: req.headers,
        body: bodyBuf.toString("utf8"),
        op: "net_request",
      };
      reqMsg = await transformNetBody(agent, "request", reqMsg);
      if (
        reqMsg.host &&
        !reqMsg.hadVault &&
        !reqMsg.vaultResolved &&
        looksLikeMitmChallengeUrl(reqMsg.url || reqMsg.path)
      ) {
        markAdaptivePassthrough(reqMsg.host, "mitm_challenge_url");
      }
      auditNet(reqMsg);
      if (reqMsg.denied) {
        releaseSession(agent.id);
        res.writeHead(403);
        res.end(reqMsg.denyReason || "Forbidden");
        return;
      }

      const headers = { ...(reqMsg.headers || req.headers) };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      let outBody = bodyBuf;
      const bodyChanged =
        reqMsg.body != null && String(reqMsg.body) !== bodyBuf.toString("utf8");
      if (reqMsg.vaultResolved || bodyChanged) {
        outBody = Buffer.from(String(reqMsg.body ?? ""), "utf8");
        headers["content-length"] = String(outBody.length);
        delete headers["transfer-encoding"];
      }

      let upstreamUrl = target;
      try {
        if (reqMsg.url && reqMsg.url !== req.url) {
          upstreamUrl = new URL(reqMsg.url);
        }
      } catch {
        upstreamUrl = target;
      }

      const upstream = http.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
          path: upstreamUrl.pathname + upstreamUrl.search,
          method: req.method,
          headers,
        },
        (upRes) => {
          const resChunks = [];
          upRes.on("data", (c) => resChunks.push(c));
          upRes.on("end", async () => {
            releaseSession(agent.id);
            const resBody = Buffer.concat(resChunks);
            let resMsg = {
              agentId: agent.id,
              direction: "response",
              host: target.host,
              method: req.method,
              url: req.url,
              statusCode: upRes.statusCode,
              headers: upRes.headers,
              body: resBody.toString("utf8"),
              op: "net_response",
            };
            resMsg = await transformNetBody(agent, "response", resMsg);
            auditNet(resMsg);
            if (resMsg.denied) {
              if (!res.headersSent) res.writeHead(403);
              res.end(resMsg.denyReason || "Forbidden");
              return;
            }
            const outHeaders = { ...(resMsg.headers || upRes.headers) };
            let outResBody = resBody;
            if (
              shouldProcessNetText(outHeaders, resMsg.body) &&
              resMsg.body != null &&
              String(resMsg.body) !== resBody.toString("utf8")
            ) {
              outResBody = Buffer.from(String(resMsg.body), "utf8");
              outHeaders["content-length"] = String(outResBody.length);
              delete outHeaders["transfer-encoding"];
              delete outHeaders["content-encoding"];
            }
            res.writeHead(upRes.statusCode || 502, outHeaders);
            res.end(outResBody);
          });
        },
      );
      upstream.on("error", (err) => {
        releaseSession(agent.id);
        logBridge("proxy_http_error", { agentId: agent.id, error: String(err) });
        if (!res.headersSent) res.writeHead(502);
        res.end(String(err));
      });
      if (outBody.length) upstream.write(outBody);
      upstream.end();
    });
    req.on("close", () => {
      /* end handler releases */
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    const agent = resolveAgentFromRequestHeaders(req.headers);
    if (!agent) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="host-bridge"\r\n\r\n',
      );
      clientSocket.end();
      return;
    }

    const { host, portNum } = parseConnectTarget(req.url);

    // vault:// must never ride CONNECT TUNNEL (body invisible). Deny early.
    const connectHeaderBlob = Object.entries(req.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (hasVaultRefs(req.url) || hasVaultRefs(connectHeaderBlob)) {
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
          "vault:// on CONNECT denied — use vault_http / bridge MEDIATE\n",
      );
      clientSocket.end();
      auditNet({
        agentId: agent.id,
        op: "net_request",
        ok: false,
        error: "vault_on_connect_denied",
        host,
      });
      return;
    }

    try {
      assertProxyUrlAllowed(agent, `${host}:${portNum}`);
      acquireSession(agent.id);
    } catch (err) {
      const status = err.code === "EBUSY" ? 429 : 403;
      clientSocket.write(`HTTP/1.1 ${status} Forbidden\r\n\r\n`);
      clientSocket.end();
      auditNet({
        agentId: agent.id,
        op: "net_request",
        ok: false,
        error: err.message,
        host,
      });
      return;
    }

    const passthrough = shouldPassthroughMitm(host);
    logBridge(passthrough ? "proxy_connect_passthrough" : "proxy_connect_mitm", {
      agentId: agent.id,
      host,
      port: portNum,
    });
    auditNet({
      agentId: agent.id,
      op: "net_request",
      method: "CONNECT",
      host,
      port: portNum,
      ok: true,
      passthrough,
    });

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseSession(agent.id);
      clientSocket.off("close", releaseOnce);
    };
    clientSocket.on("close", releaseOnce);

    // Auth / OAuth / Cursor login / CF-hardened sites: raw tunnel when
    // adaptively marked (runtime only — see CONSTRAINTS.md).
    if (passthrough) {
      connectTcp(portNum, host)
        .then((upstream) => {
          try {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          } catch (_) {
            upstream.destroy();
            releaseOnce();
            return;
          }
          if (head?.length) upstream.write(head);
          pipeRaw(clientSocket, upstream);
        })
        .catch((err) => {
          logBridge("proxy_connect_error", {
            agentId: agent.id,
            host,
            error: String(err),
            passthrough: true,
          });
          try {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.end();
          } catch (_) {}
          releaseOnce();
        });
      return;
    }

    let hostCert;
    try {
      hostCert = getHostCertificate(host);
    } catch (err) {
      releaseOnce();
      logBridge("mitm_cert_error", { host, error: String(err) });
      clientSocket.end();
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) clientSocket.unshift(head);

    const mitmServer = tls.createServer(
      {
        key: hostCert.key,
        cert: hostCert.cert,
        ca: hostCert.ca,
        // Our inspector only speaks HTTP/1.1. If ALPN negotiates h2, Chromium
        // sends HTTP/2 frames we mis-parse → intermittent blank searches.
        ALPNProtocols: ["http/1.1"],
      },
      (clientTls) => {
        const upstreamTls = tls.connect(
          {
            host,
            port: portNum,
            servername: host,
            rejectUnauthorized: true,
            family: 4,
            ALPNProtocols: ["http/1.1"],
          },
          () => {
            pipeInspected(clientTls, upstreamTls, { agent, host });
          },
        );
        upstreamTls.on("error", (err) => {
          // IPv4 failed — try default (may be IPv6)
          if (err.code === "ENETUNREACH" || err.code === "EHOSTUNREACH") {
            const retry = tls.connect(
              {
                host,
                port: portNum,
                servername: host,
                rejectUnauthorized: true,
                ALPNProtocols: ["http/1.1"],
              },
              () => {
                pipeInspected(clientTls, retry, { agent, host });
              },
            );
            retry.on("error", (err2) => {
              logBridge("proxy_connect_error", {
                agentId: agent.id,
                host,
                error: String(err2),
              });
              clientTls.destroy();
            });
            return;
          }
          logBridge("proxy_connect_error", {
            agentId: agent.id,
            host,
            error: String(err),
          });
          clientTls.destroy();
        });
        clientTls.on("error", () => upstreamTls.destroy());
      },
    );

    mitmServer.on("tlsClientError", (err) => {
      // Client rejected MITM (pinning / custom trust). Mark domain for blind
      // passthrough and drop this socket so the client retries CONNECT and
      // lands on the passthrough path (needed for Cursor api*.cursor.sh login).
      markAdaptivePassthrough(host, `tls_client_error:${err?.code || err?.message || "unknown"}`);
      logBridge("mitm_tls_client_error", {
        agentId: agent.id,
        host,
        error: String(err),
      });
      try {
        mitmServer.close();
      } catch (_) {}
      try {
        if (!clientSocket.destroyed) clientSocket.destroy();
      } catch (_) {}
      releaseOnce();
    });

    mitmServer.on("error", (err) => {
      logBridge("mitm_server_error", { host, error: String(err) });
      clientSocket.destroy();
      releaseOnce();
    });

    mitmServer.emit("connection", clientSocket);
  });

  server.listen(port, "127.0.0.1", () => {
    logBridge("proxy_listening", {
      message: `Host inspecting proxy on 127.0.0.1:${port} (HTTPS MITM + traffic log)`,
    });
  });

  return { server, port };
};
