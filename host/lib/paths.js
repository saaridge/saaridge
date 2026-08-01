import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const STATE_DIR = path.join(ROOT, "state");
/** Bridge-only secrets (ciphertext + key). Never mount into the container / FUSE. */
export const PRIVATE_STATE_DIR = path.join(STATE_DIR, "private");
export const VAULT_DIR = path.join(PRIVATE_STATE_DIR, "vault");
export const VAULT_KEY_PATH = path.join(PRIVATE_STATE_DIR, "vault.key");
/** Legacy plaintext vault (migrated once into VAULT_DIR). */
export const LEGACY_VAULT_DIR = path.join(STATE_DIR, "vault");
export const AGENTS_STATE = path.join(STATE_DIR, "agents.json");
export const TOOLS_STATE = path.join(STATE_DIR, "tools.json");
export const LOG_DIR = path.join(STATE_DIR, "logs");
export const TOKEN_FILE = path.join(STATE_DIR, "bridge.token");
export const CONTAINER_NAME = "agent-bridge-box";
