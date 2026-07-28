import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import crypto from "node:crypto";
import { URL } from "node:url";
import { resolveAgentFromRequestHeaders } from "../lib/auth.js";
import { logBridge } from "../lib/logger.js";
import { ensureMitmCa, getHostCertificate } from "../lib/mitm-certs.js";
import { HttpMessageTap, logTraffic } from "../lib/traffic-log.js";
import { audit } from "./data/audit.js";
import * as control from "./control/index.js";
import { shouldProcessNetText, isCompressedContent, shouldStreamOpaqueBody } from "./transformers/text.js";

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
  adaptivePassthroughByBase.set(base, {
    until: Date.now() + ADAPTIVE_PASSTHROUGH_TTL_MS,
    reason: String(reason || "mitm_incompatible"),
    sampleHost: String(host || base),
  });
  logBridge("proxy_adaptive_passthrough", {
    host,
    base,
    reason: String(reason || "mitm_incompatible"),
    ttlMs: ADAPTIVE_PASSTHROUGH_TTL_MS,
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
  return /just a moment|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|attention required|enable javascript and cookies/i.test(
    s,
  );
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
  const range = reqHeaders.range || reqHeaders.Range;
  const ctype = String(
    headers["content-type"] || headers["Content-Type"] || "",
  ).toLowerCase();
  if (range) return true;
  if (/videoplayback|mime=video|mime=audio|itag=\d+|\/video\/|\/audio\//i.test(url)) {
    return true;
  }
  if (/video\/|audio\//i.test(accept)) return true;
  if (/video\/|audio\//i.test(ctype)) return true;
  return false;
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

/** Mediation via control pipeline — vault:// resolved after lib.onNetRequest. */
export const transformNetBody = async (agent, direction, msg) => {
  try {
    if (direction === "request") {
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
        };
      }
      return {
        ...msg,
        url: result.url != null ? result.url : msg.url,
        body: result.body !== undefined ? result.body : msg.body,
        headers: result.headers || msg.headers,
        vaultResolved: !!result.vaultResolved,
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
    // is blind passthrough (no static URL list).
    if (
      msg.host &&
      looksLikeMitmBlockingChallenge(
        result?.action === "rewrite" ? result.body : msg.body,
      )
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
  }
  return msg;
};

const auditNet = (entry) => {
  audit({
    plane: "net",
    ...entry,
  });
  logTraffic(entry);
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
          let text = payload.toString("utf8");
          try {
            const result = await control.onNetResponse({
              agent,
              url: `wss://${host}/`,
              method: "WEBSOCKET",
              status: 101,
              headers: { "content-type": "text/plain" },
              body: text,
            });
            if (result?.action === "deny") {
              text = "";
            } else if (result?.action === "rewrite" && result.body != null) {
              text = String(result.body);
            }
          } catch (err) {
            logBridge("ws_transform_error", { error: String(err), label });
          }
          const clientToServer = label === "client_to_server";
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
  let mode = "http"; // http | ws | sse | opaque-body
  let clientBuf = Buffer.alloc(0);
  let upstreamBuf = Buffer.alloc(0);
  let opaqueLeft = 0; // remaining body bytes to stream when mode === opaque-body
  /** @type {{ url: string, path: string, headers: Record<string, string> }} */
  let lastClientReq = { url: "", path: "", headers: {} };

  const onClientData = (chunk) => {
    if (mode === "opaque-body") {
      // Client→server during download (rare); keep connection alive
      if (!upstreamTls.destroyed) upstreamTls.write(chunk);
      return;
    }
    if (mode !== "http") return;
    void forwardHttpSide("request", chunk);
  };
  const onUpstreamData = (chunk) => {
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
    if (!/Accept-Encoding:/i.test(text) || !text.includes("\r\n\r\n")) return buf;
    const next = text.replace(
      /Accept-Encoding:[^\r\n]*/i,
      "Accept-Encoding: gzip, deflate",
    );
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
      try {
        const result = await control.onNetResponse({
          agent,
          url: `https://${host}/`,
          method: "GET",
          status: 200,
          headers: {
            ...headers,
            "content-type": headers["content-type"] || "text/event-stream",
          },
          body: text,
        });
        if (result?.action === "deny") text = "";
        else if (result?.action === "rewrite" && result.body != null) {
          text = String(result.body);
        }
      } catch (err) {
        logBridge("sse_transform_error", { error: String(err) });
      }
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
    const isSse =
      /text\/event-stream/i.test(ctype) ||
      (/text\//i.test(ctype) && chunked && direction === "response");

    if (direction === "request") {
      const reqLine = head.split("\r\n")[0] || "";
      const reqPath = reqLine.split(" ")[1] || "/";
      lastClientReq = {
        url: `https://${host}${reqPath}`,
        path: reqPath,
        headers: { ...headers },
      };
    } else {
      const statusCode = Number((head.split("\r\n")[0] || "").split(" ")[1]) || 0;
      // Media CDNs often 403 Node's MITM TLS fingerprint — adapt domain (no URL list).
      if (looksLikeMitmMediaRejection(statusCode, headers, lastClientReq)) {
        markAdaptivePassthrough(host, "mitm_media_reject");
      }
    }

    // Installers / large binaries: stream immediately (do not buffer entire .deb).
    // Requests still go through vault:// mediation above when text/headers apply.
    if (
      direction === "response" &&
      !chunked &&
      shouldStreamOpaqueBody(headers, cl || 0)
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

    if (chunked) {
      // Non-SSE chunked: audit via tap, forward opaque
      const side = new HttpMessageTap({
        agentId: agent.id,
        host,
        direction,
        onMessage: (msg) => {
          void transformNetBody(agent, direction, msg).then((next) =>
            auditNet({
              ...next,
              op: direction === "request" ? "net_request" : "net_response",
            }),
          );
        },
      });
      side.push(raw);
      const dest = direction === "request" ? upstreamTls : clientTls;
      if (!dest.destroyed) dest.write(raw);
      if (direction === "request") clientBuf = Buffer.alloc(0);
      else upstreamBuf = Buffer.alloc(0);
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
    // Never UTF-8-decode compressed payloads for transforms (breaks sites like
    // lichess under MITM while passthrough hosts like google still "work").
    if (isCompressedContent(headers) || (bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b)) {
      const dest = direction === "request" ? upstreamTls : clientTls;
      if (!dest.destroyed) dest.write(messageBuf);
      auditNet({
        agentId: agent.id,
        op: direction === "request" ? "net_request" : "net_response",
        host,
        method: direction === "request" ? method : undefined,
        statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
        compressed: true,
        bytes: bodyBuf.length,
      });
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
    msg = await transformNetBody(agent, direction, msg);
    auditNet({
      ...msg,
      op: direction === "request" ? "net_request" : "net_response",
    });

    const dest = direction === "request" ? upstreamTls : clientTls;
    if (msg.denied) {
      if (direction === "request") {
        const deny = Buffer.from(
          "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
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
      markAdaptivePassthrough(host, `tls_client_error:${err?.code || err?.message || "unknown"}`);
      logBridge("mitm_tls_client_error", {
        agentId: agent.id,
        host,
        error: String(err),
      });
    });

    mitmServer.on("error", (err) => {
      logBridge("mitm_server_error", { host, error: String(err) });
      clientSocket.destroy();
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
