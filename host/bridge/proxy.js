import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { resolveAgentFromRequestHeaders } from "../lib/auth.js";
import { logBridge } from "../lib/logger.js";
import { ensureMitmCa, getHostCertificate } from "../lib/mitm-certs.js";
import { HttpMessageTap, logTraffic } from "../lib/traffic-log.js";

const pipeInspected = (clientTls, upstreamTls, { agentId, host }) => {
  const reqTap = new HttpMessageTap({
    agentId,
    host,
    direction: "request",
    onMessage: (msg) => logTraffic(msg),
  });
  const resTap = new HttpMessageTap({
    agentId,
    host,
    direction: "response",
    onMessage: (msg) => logTraffic(msg),
  });

  // Prefer encodings we can decode on the host (gzip/deflate)
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
    if (agent.policy?.allowAllProxy === false) {
      res.writeHead(403);
      res.end("Proxy denied by policy");
      return;
    }

    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("Bad URL");
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      logTraffic({
        agentId: agent.id,
        direction: "request",
        host: target.host,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyBuf.toString("utf8"),
      });

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
            const resBody = Buffer.concat(resChunks);
            logTraffic({
              agentId: agent.id,
              direction: "response",
              host: target.host,
              method: req.method,
              url: req.url,
              statusCode: upRes.statusCode,
              headers: upRes.headers,
              body: resBody.toString("utf8"),
            });
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            res.end(resBody);
          });
        },
      );
      upstream.on("error", (err) => {
        logBridge("proxy_http_error", { agentId: agent.id, error: String(err) });
        if (!res.headersSent) res.writeHead(502);
        res.end(String(err));
      });
      if (bodyBuf.length) upstream.write(bodyBuf);
      upstream.end();
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
    if (agent.policy?.allowAllProxy === false) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    const [host, portStr] = (req.url || "").split(":");
    const portNum = Number(portStr || 443);
    logBridge("proxy_connect_mitm", { agentId: agent.id, host, port: portNum });

    let hostCert;
    try {
      hostCert = getHostCertificate(host);
    } catch (err) {
      logBridge("mitm_cert_error", { host, error: String(err) });
      clientSocket.end();
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) clientSocket.unshift(head);

    // Hand the already-open socket to a one-shot TLS server (handshake completes in callback)
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
          },
          () => {
            pipeInspected(clientTls, upstreamTls, {
              agentId: agent.id,
              host,
            });
          },
        );
        upstreamTls.on("error", (err) => {
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

    // Drive TLS handshake on the existing CONNECT socket
    mitmServer.emit("connection", clientSocket);
  });

  server.listen(port, "127.0.0.1", () => {
    logBridge("proxy_listening", {
      message: `Host inspecting proxy on 127.0.0.1:${port} (HTTPS MITM + traffic log)`,
    });
  });

  return { server, port };
};
