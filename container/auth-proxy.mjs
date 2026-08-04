#!/usr/bin/env node
/**
 * Per-agent local auth proxy (runs inside the container as the agent UID).
 * Chromium points here with no credentials; we add Proxy-Authorization
 * using this process's BRIDGE_TOKEN and forward to the host bridge proxy.
 *
 * Classification (no hostname allowlists):
 *   - Cleartext HTTP with vault:// or X-OneBridge-Mediate → bridge MEDIATE
 *     (/v1/vault/fetch). Upstream TCP is opened by the host bridge only.
 *   - Otherwise → forward to host :7332 (MITM or adaptive TUNNEL).
 */
import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.LOCAL_PROXY_PORT || 18080);
const upstreamHost = process.env.BRIDGE_PROXY_HOST || "host.docker.internal";
const upstreamPort = Number(process.env.BRIDGE_PROXY_PORT || 7332);
const bridgeUrl = (
  process.env.BRIDGE_URL ||
  `http://${process.env.BRIDGE_HOST || "host.docker.internal"}:${process.env.BRIDGE_PORT || 7331}`
).replace(/\/$/, "");
const token = process.env.BRIDGE_TOKEN || "";
const agentId = process.env.AGENT_ID || "agent";

if (!token) {
  console.error("[auth-proxy] BRIDGE_TOKEN required");
  process.exit(1);
}

const proxyAuth =
  "Basic " + Buffer.from(`${agentId}:${token}`, "utf8").toString("base64");

const VAULT_REF_RE = /vault:\/\/[a-f0-9]+/i;

const hasVaultRefs = (value) => VAULT_REF_RE.test(String(value ?? ""));

const hasMediateHeader = (headers = {}) => {
  const raw =
    headers["x-onebridge-mediate"] || headers["X-OneBridge-Mediate"] || "";
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
};

const requiresMediate = ({ url, headers, body } = {}) => {
  if (hasMediateHeader(headers)) return true;
  if (hasVaultRefs(url)) return true;
  if (hasVaultRefs(body)) return true;
  for (const v of Object.values(headers || {})) {
    if (hasVaultRefs(v)) return true;
  }
  return false;
};

const stripHopHeaders = (headers) => {
  const out = { ...headers };
  delete out["proxy-authorization"];
  delete out["proxy-connection"];
  delete out["connection"];
  delete out["keep-alive"];
  delete out["transfer-encoding"];
  delete out["upgrade"];
  delete out["x-onebridge-mediate"];
  return out;
};

/** Bridge-owned fetch for vault-bearing cleartext HTTP. */
const mediateViaBridge = async (req, res, bodyBuf) => {
  let targetUrl = req.url;
  try {
    // Absolute-form proxy URL
    const u = new URL(req.url);
    targetUrl = u.toString();
  } catch {
    /* keep */
  }

  const headers = stripHopHeaders(req.headers);
  const payload = {
    method: req.method || "GET",
    url: targetUrl,
    headers,
    body:
      bodyBuf && bodyBuf.length
        ? bodyBuf.toString("utf8")
        : undefined,
  };

  try {
    const upstream = await fetch(`${bridgeUrl}/v1/vault/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Proxy-Authorization": proxyAuth,
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || data.ok === false) {
      const msg =
        data.error || data.message || `mediate failed (${upstream.status})`;
      if (!res.headersSent) {
        res.writeHead(upstream.status === 403 ? 403 : 502, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }
      res.end(String(msg));
      return;
    }
    const outHeaders = { ...(data.headers || {}) };
    delete outHeaders["transfer-encoding"];
    delete outHeaders["content-encoding"];
    const body = data.body != null ? String(data.body) : "";
    outHeaders["content-length"] = String(Buffer.byteLength(body));
    if (!res.headersSent) {
      res.writeHead(Number(data.status) || 200, outHeaders);
    }
    res.end(body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502);
    res.end(`OneBridge mediate error: ${err?.message || err}`);
  }
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    const bodyText = bodyBuf.length ? bodyBuf.toString("utf8") : "";

    if (
      requiresMediate({
        url: req.url,
        headers: req.headers,
        body: bodyText,
      })
    ) {
      console.error(
        `[auth-proxy] MEDIATE vault/fetch method=${req.method} url=${String(req.url).slice(0, 120)}`,
      );
      void mediateViaBridge(req, res, bodyBuf);
      return;
    }

    const headers = { ...req.headers, "proxy-authorization": proxyAuth };
    delete headers["proxy-connection"];

    const upstream = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(err));
    });
    if (bodyBuf.length) upstream.write(bodyBuf);
    upstream.end();
  });
});

server.on("connect", (req, clientSocket, head) => {
  // CONNECT has no body; reject if vault markers somehow appear in URL/headers
  // (cannot safely TUNNEL redacted material).
  const headerBlob = Object.entries(req.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (hasVaultRefs(req.url) || hasVaultRefs(headerBlob)) {
    try {
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
          "OneBridge: vault:// on CONNECT is denied — use vault_http / cleartext mediate path\n",
      );
    } catch (_) {}
    try {
      clientSocket.destroy();
    } catch (_) {}
    return;
  }

  let settled = false;
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    console.error(
      `[auth-proxy] upstream ${upstreamHost}:${upstreamPort} failed:`,
      msg,
    );
    try {
      if (!clientSocket.destroyed && !clientSocket.writableEnded) {
        clientSocket.write(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
            `OneBridge host proxy error (${upstreamHost}:${upstreamPort}): ${msg}\n`,
        );
      }
    } catch (_) {}
    try {
      clientSocket.destroy();
    } catch (_) {}
  };

  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    upstream.write(
      `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${proxyAuth}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      fail("CONNECT handshake timeout");
      try {
        upstream.destroy();
      } catch (_) {}
    }, 20_000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx < 0) return;
      clearTimeout(timer);
      // Pause before removing the listener so TLS/HTTP bytes that arrive in the
      // same tick are not dropped (blank pages / empty MITM bodies).
      upstream.pause();
      upstream.off("data", onData);
      const header = buffer.slice(0, idx).toString("utf8");
      const rest = buffer.slice(idx + 4);
      if (!header.startsWith("HTTP/1.1 200") && !header.startsWith("HTTP/1.0 200")) {
        settled = true;
        try {
          clientSocket.write(buffer);
        } catch (_) {}
        clientSocket.end();
        upstream.end();
        return;
      }
      settled = true;
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } catch (_) {
        upstream.destroy();
        return;
      }
      if (rest.length) {
        try {
          clientSocket.write(rest);
        } catch (_) {
          upstream.destroy();
          return;
        }
      }
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.resume();
    };
    upstream.on("data", onData);
    upstream.on("end", () => {
      if (!settled) fail("upstream closed before CONNECT response");
    });
  });
  upstream.on("error", (err) => fail(err.message || String(err)));
  clientSocket.on("error", () => {
    try {
      upstream.destroy();
    } catch (_) {}
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.error(
    `[auth-proxy] agent=${agentId} listening 127.0.0.1:${listenPort} → ${upstreamHost}:${upstreamPort}`,
  );
});
