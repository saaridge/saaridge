#!/usr/bin/env node
/**
 * Per-agent local auth proxy (runs inside the container as the agent UID).
 * Chromium points here with no credentials; we add Proxy-Authorization
 * using this process's BRIDGE_TOKEN and forward to the host bridge proxy.
 */
import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.LOCAL_PROXY_PORT || 18080);
const upstreamHost = process.env.BRIDGE_PROXY_HOST || "host.docker.internal";
const upstreamPort = Number(process.env.BRIDGE_PROXY_PORT || 7332);
const token = process.env.BRIDGE_TOKEN || "";
const agentId = process.env.AGENT_ID || "agent";

if (!token) {
  console.error("[auth-proxy] BRIDGE_TOKEN required");
  process.exit(1);
}

const proxyAuth =
  "Basic " + Buffer.from(`${agentId}:${token}`, "utf8").toString("base64");

const server = http.createServer((req, res) => {
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
  req.pipe(upstream);
});

server.on("connect", (req, clientSocket, head) => {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    upstream.write(
      `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${proxyAuth}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx < 0) return;
      upstream.off("data", onData);
      const header = buffer.slice(0, idx).toString("utf8");
      const rest = buffer.slice(idx + 4);
      if (!header.startsWith("HTTP/1.1 200") && !header.startsWith("HTTP/1.0 200")) {
        clientSocket.write(buffer);
        clientSocket.end();
        upstream.end();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) clientSocket.write(rest);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    };
    upstream.on("data", onData);
  });
  upstream.on("error", (err) => {
    console.error(
      `[auth-proxy] upstream ${upstreamHost}:${upstreamPort} failed:`,
      err.message,
    );
    try {
      clientSocket.write(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
          `OneBridge host proxy unreachable at ${upstreamHost}:${upstreamPort}. ` +
          "Start the host (scripts/start-host.sh) and reload.\n",
      );
    } catch (_) {}
    clientSocket.end();
  });
  clientSocket.on("error", () => upstream.end());
});

server.listen(listenPort, "127.0.0.1", () => {
  console.error(
    `[auth-proxy] agent=${agentId} listening 127.0.0.1:${listenPort} → ${upstreamHost}:${upstreamPort}`,
  );
});
