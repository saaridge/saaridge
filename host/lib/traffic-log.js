import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { LOG_DIR } from "./paths.js";

fs.mkdirSync(LOG_DIR, { recursive: true });
const TRAFFIC_FILE = path.join(LOG_DIR, "traffic.jsonl");

const MAX_BODY = 64_000;

const truncate = (value) => {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s.length <= MAX_BODY) return s;
  return `${s.slice(0, MAX_BODY)}\n…[truncated ${s.length - MAX_BODY} bytes]`;
};

/**
 * Append one inspected network event (request or response) for an agent.
 */
export const logTraffic = (entry) => {
  const row = {
    ts: new Date().toISOString(),
    ...entry,
    body: truncate(entry.body),
  };
  fs.appendFileSync(TRAFFIC_FILE, JSON.stringify(row) + "\n");
  const preview = (entry.body || "").slice(0, 120).replace(/\s+/g, " ");
  // Never print resolved secrets to host console.
  const safePreview =
    entry.bodyRedacted || entry.vaultResolved || entry.hadVault
      ? "<redacted>"
      : preview;
  console.log(
    `[traffic] agent=${entry.agentId || "?"} ${entry.direction} ${entry.method || ""} ${entry.url || entry.host || ""} ${entry.statusCode || ""} ${safePreview}`,
  );
};

export const readTraffic = (limit = 200, agentId = null) => {
  if (!fs.existsSync(TRAFFIC_FILE)) return [];
  const lines = fs
    .readFileSync(TRAFFIC_FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-Math.max(limit * 3, limit));
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (agentId && row.agentId !== agentId) continue;
      rows.push(row);
    } catch {
      /* skip */
    }
  }
  return rows.slice(-limit);
};

/**
 * Minimal HTTP/1.x message parser for MITM tap.
 * Accumulates bytes until headers+body are complete enough to log.
 */
export class HttpMessageTap {
  constructor({ agentId, host, direction, onMessage }) {
    this.agentId = agentId;
    this.host = host;
    this.direction = direction; // "request" | "response"
    this.onMessage = onMessage;
    this.buf = Buffer.alloc(0);
    this.pending = null;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
  }

  _drain() {
    while (true) {
      if (!this.pending) {
        const idx = this.buf.indexOf("\r\n\r\n");
        if (idx < 0) {
          // Avoid unbounded header buffer
          if (this.buf.length > 256_000) this.buf = this.buf.slice(-64_000);
          return;
        }
        const head = this.buf.slice(0, idx).toString("utf8");
        this.buf = this.buf.slice(idx + 4);
        const lines = head.split("\r\n");
        const start = lines[0] || "";
        const headers = {};
        for (const line of lines.slice(1)) {
          const c = line.indexOf(":");
          if (c > 0) {
            headers[line.slice(0, c).trim().toLowerCase()] = line
              .slice(c + 1)
              .trim();
          }
        }

        if (this.direction === "request") {
          const m = start.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\d\.\d$/i);
          this.pending = {
            method: m?.[1] || "?",
            path: m?.[2] || "/",
            headers,
            bodyChunks: [],
            bodyLen: 0,
            contentLength: headers["content-length"]
              ? Number(headers["content-length"])
              : 0,
            chunked: (headers["transfer-encoding"] || "").includes("chunked"),
            done: false,
          };
        } else {
          const m = start.match(/^HTTP\/\d\.\d\s+(\d+)/i);
          this.pending = {
            statusCode: m ? Number(m[1]) : 0,
            headers,
            bodyChunks: [],
            bodyLen: 0,
            contentLength: headers["content-length"]
              ? Number(headers["content-length"])
              : 0,
            chunked: (headers["transfer-encoding"] || "").includes("chunked"),
            done: false,
          };
        }

        // No body for these
        const method = this.pending.method;
        if (
          this.direction === "request" &&
          (method === "GET" ||
            method === "HEAD" ||
            method === "DELETE" ||
            method === "OPTIONS") &&
          !this.pending.contentLength &&
          !this.pending.chunked
        ) {
          this._emit();
          continue;
        }
        if (
          this.direction === "response" &&
          (this.pending.statusCode === 204 ||
            this.pending.statusCode === 304 ||
            method === "HEAD")
        ) {
          this._emit();
          continue;
        }
        if (!this.pending.contentLength && !this.pending.chunked) {
          // Likely no body or connection-close body — emit headers now, keep reading optional body until next message/timeout
          this._emit();
          continue;
        }
      }

      if (!this.pending) return;

      if (this.pending.chunked) {
        // Best-effort: collect until we see terminating 0\r\n\r\n
        const end = this.buf.indexOf("\r\n0\r\n\r\n");
        if (end < 0) {
          if (this.buf.length > MAX_BODY * 2) {
            this.pending.bodyChunks.push(this.buf.slice(0, MAX_BODY));
            this.buf = Buffer.alloc(0);
            this._emit();
          }
          return;
        }
        this.pending.bodyChunks.push(this.buf.slice(0, end));
        this.buf = this.buf.slice(end + 5);
        this._emit();
        continue;
      }

      const need = this.pending.contentLength || 0;
      if (need <= 0) {
        this._emit();
        continue;
      }
      if (this.buf.length < need) return;
      const body = this.buf.slice(0, need);
      this.buf = this.buf.slice(need);
      this.pending.bodyChunks.push(body);
      this._emit();
    }
  }

  _emit() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    const bodyBuf = Buffer.concat(p.bodyChunks || []);
    let bodyText = "";
    const ctype = (p.headers["content-type"] || "").toLowerCase();
    const encoding = (p.headers["content-encoding"] || "").toLowerCase();

    if (
      bodyBuf.length &&
      (ctype.includes("image/") ||
        ctype.includes("video/") ||
        ctype.includes("audio/") ||
        ctype.includes("octet-stream") ||
        ctype.includes("font/") ||
        ctype.includes("wasm"))
    ) {
      bodyText = `<${ctype || "binary"} ${bodyBuf.length} bytes>`;
    } else if (
      encoding.includes("br") ||
      encoding.includes("gzip") ||
      encoding.includes("deflate") ||
      encoding.includes("zstd")
    ) {
      try {
        if (encoding.includes("gzip")) {
          bodyText = zlib.gunzipSync(bodyBuf).toString("utf8");
        } else if (encoding.includes("deflate")) {
          bodyText = zlib.inflateSync(bodyBuf).toString("utf8");
        } else {
          bodyText = `<compressed ${encoding} ${bodyBuf.length} bytes>`;
        }
      } catch {
        bodyText = `<compressed ${encoding} ${bodyBuf.length} bytes>`;
      }
    } else {
      try {
        bodyText = bodyBuf.toString("utf8");
      } catch {
        bodyText = `<binary ${bodyBuf.length} bytes>`;
      }
    }

    const url =
      this.direction === "request"
        ? `https://${this.host}${p.path || "/"}`
        : `https://${this.host}`;

    this.onMessage({
      agentId: this.agentId,
      direction: this.direction,
      host: this.host,
      method: p.method,
      url,
      path: p.path,
      statusCode: p.statusCode,
      headers: p.headers,
      body: bodyText,
    });
  }
}
