import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSecureContext } from "node:tls";
import { STATE_DIR } from "./paths.js";
import { logBridge } from "./logger.js";

const CERT_DIR = path.join(STATE_DIR, "mitm-certs");
const CA_KEY = path.join(CERT_DIR, "ca.key");
const CA_CRT = path.join(CERT_DIR, "ca.crt");
const HOST_DIR = path.join(CERT_DIR, "hosts");

const openssl = (...args) => {
  const res = spawnSync("openssl", args, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `openssl ${args[0]} failed: ${res.stderr || res.stdout || res.status}`,
    );
  }
  return res;
};

/** Ensure OneBridge MITM CA exists (generated once, reused). */
export const ensureMitmCa = () => {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.mkdirSync(HOST_DIR, { recursive: true });
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CRT)) {
    return { keyPath: CA_KEY, certPath: CA_CRT, certDir: CERT_DIR };
  }

  openssl(
    "genrsa",
    "-out",
    CA_KEY,
    "2048",
  );
  openssl(
    "req",
    "-new",
    "-x509",
    "-days",
    "3650",
    "-key",
    CA_KEY,
    "-out",
    CA_CRT,
    "-subj",
    "/CN=OneBridge MITM CA/O=OneBridge Controlled Env",
  );
  logBridge("mitm_ca_created", { certPath: CA_CRT });
  return { keyPath: CA_KEY, certPath: CA_CRT, certDir: CERT_DIR };
};

export const getCaPem = () => {
  ensureMitmCa();
  return fs.readFileSync(CA_CRT, "utf8");
};

/**
 * Return TLS key/cert PEM for a hostname (cached on disk).
 * Uses the OneBridge CA so Chromium can trust all forged host certs.
 */
export const getHostCertificate = (hostname) => {
  ensureMitmCa();
  const safe = String(hostname || "unknown")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .slice(0, 200);
  const keyPath = path.join(HOST_DIR, `${safe}.key`);
  const crtPath = path.join(HOST_DIR, `${safe}.crt`);
  const csrPath = path.join(HOST_DIR, `${safe}.csr`);
  const extPath = path.join(HOST_DIR, `${safe}.ext`);

  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    openssl("genrsa", "-out", keyPath, "2048");
    openssl(
      "req",
      "-new",
      "-key",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${hostname}`,
    );
    fs.writeFileSync(
      extPath,
      [
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=DNS:${hostname},DNS:*.${hostname.replace(/^www\./, "")}`,
      ].join("\n"),
    );
    openssl(
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      CA_CRT,
      "-CAkey",
      CA_KEY,
      "-CAcreateserial",
      "-out",
      crtPath,
      "-days",
      "825",
      "-extfile",
      extPath,
    );
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(crtPath),
    ca: fs.readFileSync(CA_CRT),
  };
};

export const getSecureContextForHost = (hostname) => {
  const { key, cert, ca } = getHostCertificate(hostname);
  return createSecureContext({ key, cert, ca });
};
