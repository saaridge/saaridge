/**
 * Bridge secret vault — host-derived secrets never enter the container.
 * Values stored under state/vault/<agentId>.json (mode 0600).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "../../lib/paths.js";

const VAULT_DIR = path.join(STATE_DIR, "vault");

const ensureDir = () => {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
};

const fileFor = (agentId) => {
  const id = String(agentId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(VAULT_DIR, `${id}.json`);
};

const readStore = (agentId) => {
  ensureDir();
  const file = fileFor(agentId);
  if (!fs.existsSync(file)) return { secrets: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { secrets: {} };
  }
};

const writeStore = (agentId, data) => {
  ensureDir();
  const file = fileFor(agentId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
};

/** Insert or reuse identical value; returns vault id. */
export const put = (agentId, { kind, name, value, sourcePath } = {}) => {
  const v = String(value ?? "");
  if (!v) return "";
  const store = readStore(agentId);
  for (const [id, row] of Object.entries(store.secrets || {})) {
    if (row.value === v && row.name === (name || row.name)) return id;
  }
  const id = crypto.randomBytes(8).toString("hex");
  store.secrets[id] = {
    id,
    kind: kind || "secret",
    name: name || "secret",
    value: v,
    sourcePath: sourcePath || null,
    createdAt: new Date().toISOString(),
  };
  writeStore(agentId, store);
  return id;
};

export const get = (agentId, id) => {
  const store = readStore(agentId);
  return store.secrets?.[String(id)] || null;
};

export const listMeta = (agentId) => {
  const store = readStore(agentId);
  return Object.values(store.secrets || {}).map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    sourcePath: s.sourcePath,
    createdAt: s.createdAt,
  }));
};

export const remove = (agentId, id) => {
  const store = readStore(agentId);
  if (!store.secrets?.[id]) return false;
  delete store.secrets[id];
  writeStore(agentId, store);
  return true;
};

/** Resolve Authorization / header placeholders vault://<id>. */
export const resolveVaultRefs = (agentId, text) => {
  if (text == null) return text;
  return String(text).replace(/vault:\/\/([a-f0-9]+)/gi, (_, id) => {
    const row = get(agentId, id);
    return row ? row.value : `vault://${id}`;
  });
};
