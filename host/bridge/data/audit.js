import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../../lib/paths.js";
import {
  sanitizeAuditForAgent,
  sanitizeNetAuditEntry,
} from "./audit-sanitize.js";

const AUDIT_DIR = path.join(STATE_DIR, "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "access.jsonl");
const MAX_QUEUE = 5000;
const DROP_BATCH = 500;

fs.mkdirSync(AUDIT_DIR, { recursive: true });

const queue = [];
let dropped = 0;
let writing = false;
let metrics = { enqueued: 0, written: 0, dropped: 0 };

const flush = () => {
  if (writing || queue.length === 0) return;
  writing = true;
  const batch = queue.splice(0, 200);
  const body = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFile(AUDIT_FILE, body, (err) => {
    writing = false;
    if (!err) {
      metrics.written += batch.length;
    } else {
      if (queue.length + batch.length < MAX_QUEUE) {
        queue.unshift(...batch);
      } else {
        metrics.dropped += batch.length;
        dropped += batch.length;
      }
    }
    if (queue.length) setImmediate(flush);
  });
};

/**
 * Non-blocking audit. Never throws. Drops oldest under pressure.
 * Net rows with vault are sanitized before persist (no resolved plaintext).
 */
export const audit = (entry) => {
  let payload = entry;
  if (
    entry &&
    (entry.plane === "net" ||
      String(entry.op || "").startsWith("net_") ||
      entry.vaultResolved ||
      entry.hadVault)
  ) {
    payload = sanitizeNetAuditEntry(entry);
  }
  const row = {
    ts: new Date().toISOString(),
    ...payload,
  };
  metrics.enqueued += 1;
  if (queue.length >= MAX_QUEUE) {
    queue.splice(0, DROP_BATCH);
    metrics.dropped += DROP_BATCH;
    dropped += DROP_BATCH;
  }
  queue.push(row);
  setImmediate(flush);
};

export const auditMetrics = () => ({
  ...metrics,
  queueDepth: queue.length,
  dropped,
});

/**
 * @param {number} limit
 * @param {string|null} agentId
 * @param {{ forAgent?: boolean }} opts — when forAgent, strip bodies/secrets for API.
 */
export const readAudit = (limit = 200, agentId = null, opts = {}) => {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  try {
    const lines = fs
      .readFileSync(AUDIT_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(limit * 4, limit));
    const parsed = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (agentId && j.agentId !== agentId) continue;
        parsed.push(opts.forAgent ? sanitizeAuditForAgent(j) : j);
      } catch {
        /* skip */
      }
    }
    return parsed.slice(-limit);
  } catch {
    return [];
  }
};

export { sanitizeAuditForAgent, sanitizeNetAuditEntry };
