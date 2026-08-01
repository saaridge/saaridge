/**
 * Bridge secret vault — host-derived secrets never enter the container.
 * Values encrypted at rest (AES-256-GCM, OneCLI wire format) under
 * state/private/vault/<agentId>.json (dir 0700, files 0600).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  VAULT_DIR,
  LEGACY_VAULT_DIR,
  PRIVATE_STATE_DIR,
} from "../../lib/paths.js";
import { encrypt, decrypt } from "./crypto.js";

export { hasVaultRefs, requiresMediate, hasMediateHeader } from "./markers.js";

const ensureDirs = () => {
  fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(PRIVATE_STATE_DIR, 0o700);
    fs.chmodSync(VAULT_DIR, 0o700);
  } catch {
    /* ignore */
  }
};

const fileFor = (agentId) => {
  const id = String(agentId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(VAULT_DIR, `${id}.json`);
};

const legacyFileFor = (agentId) => {
  const id = String(agentId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(LEGACY_VAULT_DIR, `${id}.json`);
};

const hashValue = (v) =>
  crypto.createHash("sha256").update(String(v), "utf8").digest("hex");

const decryptRow = (row) => {
  if (!row) return null;
  if (row.valueEnc) {
    return {
      ...row,
      value: decrypt(row.valueEnc),
    };
  }
  // Legacy plaintext row (during migrate / soft read)
  if (row.value != null) return { ...row };
  return row;
};

const persistRow = (meta, plaintext) => {
  const valueEnc = encrypt(plaintext);
  return {
    id: meta.id,
    kind: meta.kind || "secret",
    name: meta.name || "secret",
    valueEnc,
    valueHash: hashValue(plaintext),
    sourcePath: meta.sourcePath || null,
    createdAt: meta.createdAt || new Date().toISOString(),
  };
};

const migrateLegacyIfNeeded = (agentId) => {
  ensureDirs();
  const dest = fileFor(agentId);
  if (fs.existsSync(dest)) return;
  const legacy = legacyFileFor(agentId);
  if (!fs.existsSync(legacy)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(legacy, "utf8"));
  } catch {
    return;
  }
  const secrets = {};
  for (const [id, row] of Object.entries(data.secrets || {})) {
    if (!row) continue;
    if (row.valueEnc) {
      secrets[id] = {
        id: row.id || id,
        kind: row.kind || "secret",
        name: row.name || "secret",
        valueEnc: row.valueEnc,
        valueHash: row.valueHash || null,
        sourcePath: row.sourcePath || null,
        createdAt: row.createdAt || new Date().toISOString(),
      };
      continue;
    }
    if (row.value == null || row.value === "") continue;
    secrets[id] = persistRow(
      {
        id: row.id || id,
        kind: row.kind,
        name: row.name,
        sourcePath: row.sourcePath,
        createdAt: row.createdAt,
      },
      String(row.value),
    );
  }
  fs.writeFileSync(dest, JSON.stringify({ secrets }, null, 2), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* ignore */
  }
  try {
    fs.writeFileSync(
      legacy,
      JSON.stringify(
        {
          migratedTo: dest,
          migratedAt: new Date().toISOString(),
          secrets: {},
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* ignore */
  }
};

const readStore = (agentId) => {
  ensureDirs();
  migrateLegacyIfNeeded(agentId);
  const file = fileFor(agentId);
  if (!fs.existsSync(file)) return { secrets: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { secrets: {} };
  }
};

const writeStore = (agentId, data) => {
  ensureDirs();
  const file = fileFor(agentId);
  // Never persist plaintext `value` fields
  const secrets = {};
  for (const [id, row] of Object.entries(data.secrets || {})) {
    if (!row) continue;
    const { value: _drop, ...rest } = row;
    if (!rest.valueEnc) continue;
    secrets[id] = rest;
  }
  fs.writeFileSync(file, JSON.stringify({ secrets }, null, 2), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
};

/** Absolute path of on-disk vault file (for tests / isolation checks). */
export const vaultFilePath = (agentId) => fileFor(agentId);

/** Insert or reuse identical value; returns vault id. */
export const put = (agentId, { kind, name, value, sourcePath } = {}) => {
  const v = String(value ?? "");
  if (!v) return "";
  const store = readStore(agentId);
  const h = hashValue(v);
  const wantName = name || null;
  for (const [id, row] of Object.entries(store.secrets || {})) {
    if (row.valueHash === h && (!wantName || row.name === wantName)) {
      return id;
    }
    // Dedup against legacy plaintext if still present in memory only
    try {
      const plain = decryptRow(row)?.value;
      if (plain === v && (!wantName || row.name === wantName || !wantName)) {
        return id;
      }
    } catch {
      /* skip corrupt */
    }
  }
  const id = crypto.randomBytes(8).toString("hex");
  store.secrets[id] = persistRow(
    {
      id,
      kind: kind || "secret",
      name: name || "secret",
      sourcePath: sourcePath || null,
      createdAt: new Date().toISOString(),
    },
    v,
  );
  writeStore(agentId, store);
  return id;
};

/**
 * Get secret row with decrypted `value` for bridge-internal use only.
 * Never expose via agent list/get APIs.
 */
export const get = (agentId, id) => {
  const store = readStore(agentId);
  const row = store.secrets?.[String(id)];
  if (!row) return null;
  try {
    const full = decryptRow(row);
    return {
      id: full.id || id,
      kind: full.kind,
      name: full.name,
      value: full.value,
      sourcePath: full.sourcePath || null,
      createdAt: full.createdAt,
    };
  } catch {
    return null;
  }
};

/** Metadata only — never ciphertext or plaintext. */
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
