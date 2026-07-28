import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { URL } from "node:url";
import { resolveAgentFromRequestHeaders } from "../lib/auth.js";
import { logBridge } from "../lib/logger.js";
import { ensureMitmCa, getHostCertificate } from "../lib/mitm-certs.js";
import { HttpMessageTap, logTraffic } from "../lib/traffic-log.js";
import { audit } from "./data/audit.js";

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
 * Hosts where MITM breaks auth (cert pinning, WebSockets, Cloudflare challenges).
 * Still policy-checked and audited as CONNECT; TLS is end-to-end passthrough.
 */
const MITM_PASSTHROUGH_SUFFIXES = [
  "cursor.com",
  "cursor.sh",
  "cursorapi.com",
  "cursorusercontent.com",
  "workos.com",
  "workoscdn.com",
  "imgix.net",
  "accounts.google.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
  "login.microsoftonline.com",
  "microsoftonline.com",
  "live.com",
  "auth0.com",
  "okta.com",
  "cloudflare.com",
  "challenges.cloudflare.com",
];

const shouldPassthroughMitm = (host) => {
  const h = String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return false;
  return MITM_PASSTHROUGH_SUFFIXES.some(
    (suf) => h === suf || h.endsWith(`.${suf}`),
  );
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

/** Optional body transform hooks (default pass-through). */
export const transformNetBody = (agent, direction, msg) => {
  const hooks = agent?.policy?.transforms?.net;
  if (!hooks) return msg;
  try {
    if (direction === "request" && typeof hooks.onRequestBody === "function") {
      return { ...msg, body: hooks.onRequestBody(msg.body, msg) };
    }
    if (direction === "response" && typeof hooks.onResponseBody === "function") {
      return { ...msg, body: hooks.onResponseBody(msg.body, msg) };
    }
    // Policy-driven string redact patterns (serializable)
    const patterns =
      direction === "request" ? hooks.requestRedact : hooks.responseRedact;
    if (Array.isArray(patterns) && patterns.length && msg.body) {
      let text = String(msg.body);
      for (const p of patterns) {
        try {
          text = text.replace(new RegExp(String(p), "gi"), "[REDACTED]");
        } catch {
          /* skip */
        }
      }
      return { ...msg, body: text };
    }
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
  // Keep existing traffic.jsonl for UI compatibility
  logTraffic(entry);
};

const pipeInspected = (clientTls, upstreamTls, { agent, host }) => {
  const agentId = agent.id;
  const reqTap = new HttpMessageTap({
    agentId,
    host,
    direction: "request",
    onMessage: (msg) => {
      const next = transformNetBody(agent, "request", msg);
      auditNet({ ...next, op: "net_request" });
    },
  });
  const resTap = new HttpMessageTap({
    agentId,
    host,
    direction: "response",
    onMessage: (msg) => {
      const next = transformNetBody(agent, "response", msg);
      auditNet({ ...next, op: "net_response" });
    },
  });

  const rewriteAcceptEncoding = (buf) => {
    const text = buf.toString("latin1");
    if (!/Accept-Encoding:/i.test(text) || !text.includes("\r\n\r\n")) return buf;
    const next = text.replace(
      /Accept-Encoding:[^\r\n]*/i,
      "Accept-Encoding: gzip, deflate",
    );
    return Buffer.from(next, "latin1");
  };

  clientTls.on("data", (chunk) => {
    const out = rewriteAcceptEncoding(chunk);
    reqTap.push(out);
    if (!upstreamTls.destroyed) upstreamTls.write(out);
  });
  upstreamTls.on("data", (chunk) => {
    resTap.push(chunk);
    if (!clientTls.destroyed) clientTls.write(chunk);
  });

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
  clientTls.on("end", () => upstreamTls.end());
  upstreamTls.on("end", () => clientTls.end());
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
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      let reqMsg = {
        agentId: agent.id,
        direction: "request",
        host: target.host,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyBuf.toString("utf8"),
        op: "net_request",
      };
      reqMsg = transformNetBody(agent, "request", reqMsg);
      auditNet(reqMsg);

      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];

      const upstream = http.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: req.method,
          headers,
        },
        (upRes) => {
          const resChunks = [];
          upRes.on("data", (c) => resChunks.push(c));
          upRes.on("end", () => {
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
            resMsg = transformNetBody(agent, "response", resMsg);
            auditNet(resMsg);
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            res.end(resBody);
          });
        },
      );
      upstream.on("error", (err) => {
        releaseSession(agent.id);
        logBridge("proxy_http_error", { agentId: agent.id, error: String(err) });
        if (!res.headersSent) res.writeHead(502);
        res.end(String(err));
      });
      if (bodyBuf.length) upstream.write(bodyBuf);
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

    // Auth / OAuth / Cursor login: raw tunnel (no decrypt) so login pages work.
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
      },
      (clientTls) => {
        const upstreamTls = tls.connect(
          {
            host,
            port: portNum,
            servername: host,
            rejectUnauthorized: true,
            family: 4,
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
