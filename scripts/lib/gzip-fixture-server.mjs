/**
 * Start/stop an HTTPS gzip fixture (no Content-Length) for proxy regression tests.
 */
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureMitmCa } from "../../host/lib/mitm-certs.js";

export const FIXTURE_MARKER = "SAARIDGE_GZIP_PROXY_MARKER_v1";

export function startGzipFixtureServer({ host = "localhost" } = {}) {
  const { certPath, keyPath: caKeyPath } = ensureMitmCa();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-gzip-fixture-"));
  const keyPath = path.join(dir, "key.pem");
  const csrPath = path.join(dir, "csr.pem");
  const certOut = path.join(dir, "cert.pem");

  let res = spawnSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || "openssl csr failed");

  res = spawnSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      certPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      certOut,
      "-days",
      "1",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || "openssl sign failed");

  const plain = Buffer.from(
    `<!doctype html><html><body>${FIXTURE_MARKER}</body></html>`,
    "utf8",
  );
  const gzBody = zlib.gzipSync(plain);

  const server = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certOut),
    },
    (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
        Connection: "close",
      });
      res.end(gzBody);
    },
  );

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        host,
        plainLength: plain.length,
        cleanup() {
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}
