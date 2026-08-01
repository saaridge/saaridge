/**
 * OneCLI-compatible AES-256-GCM for vault secrets at rest.
 * Wire format: `${iv_b64}:${authTag_b64}:${ciphertext_b64}`
 */
import fs from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { VAULT_KEY_PATH, PRIVATE_STATE_DIR } from "../../lib/paths.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey;

const ensurePrivateDir = () => {
  fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(PRIVATE_STATE_DIR, 0o700);
  } catch {
    /* ignore */
  }
};

const loadOrCreateKey = () => {
  if (process.env.ONEBRIDGE_VAULT_KEY) {
    const key = Buffer.from(process.env.ONEBRIDGE_VAULT_KEY, "base64");
    if (key.length !== 32) {
      throw new Error(
        "ONEBRIDGE_VAULT_KEY must be base64 of exactly 32 bytes",
      );
    }
    return key;
  }
  ensurePrivateDir();
  if (fs.existsSync(VAULT_KEY_PATH)) {
    const raw = fs.readFileSync(VAULT_KEY_PATH, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error(`Invalid vault key at ${VAULT_KEY_PATH}`);
    }
    return key;
  }
  const key = randomBytes(32);
  fs.writeFileSync(VAULT_KEY_PATH, key.toString("base64") + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(VAULT_KEY_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return key;
};

const getKey = () => {
  if (!cachedKey) cachedKey = loadOrCreateKey();
  return cachedKey;
};

/** Encrypt plaintext → iv:tag:ciphertext (base64 parts). */
export const encrypt = (plaintext) => {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
};

/** Decrypt OneCLI-format ciphertext. */
export const decrypt = (encrypted) => {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = String(encrypted || "").split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("invalid encrypted format: expected iv:authTag:ciphertext");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  if (iv.length !== IV_LENGTH) {
    throw new Error(`invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${authTag.length}`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
};

/** True if string looks like encrypted vault blob (not plaintext). */
export const looksEncrypted = (value) => {
  const parts = String(value || "").split(":");
  if (parts.length !== 3) return false;
  try {
    return (
      Buffer.from(parts[0], "base64").length === IV_LENGTH &&
      Buffer.from(parts[1], "base64").length === AUTH_TAG_LENGTH &&
      parts[2].length > 0
    );
  } catch {
    return false;
  }
};

export { VAULT_KEY_PATH };
