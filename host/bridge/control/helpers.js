/**
 * Optional helpers for control/lib.js — not run automatically.
 *
 * Example (in onFsRead):
 *   import { extractSecretsToVault } from "./helpers.js";
 *   const text = await extractSecretsToVault(agent, path, String(data));
 *   return { action: "rewrite", data: Buffer.isBuffer(data) ? Buffer.from(text) : text };
 */
import * as vault from "../vault/index.js";

const DEFAULT_SECRET_PATTERN =
  /(?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{12,})/gi;

/**
 * Replace secret-looking assignments with vault://<id> and store values on the bridge.
 */
export const extractSecretsToVault = (
  agent,
  filePath,
  text,
  { pattern = DEFAULT_SECRET_PATTERN, name = "assigned_secret" } = {},
) => {
  const agentId = agent?.id;
  if (!agentId || text == null) return text;
  return String(text).replace(pattern, (...args) => {
    const full = args[0];
    const groups = args.slice(1, -2).filter((g) => typeof g === "string" && g.length > 0);
    const secret = groups.length ? groups[groups.length - 1] : full;
    const id = vault.put(agentId, {
      kind: "extracted",
      name,
      value: secret,
      sourcePath: filePath,
    });
    if (groups.length && full.includes(secret)) {
      return full.replace(secret, `vault://${id}`);
    }
    return `vault://${id}`;
  });
};

/** Apply a list of regex patterns, replacing matches with `replacement`. */
export const applyRedactPatterns = (text, patterns, replacement = "[REDACTED]") => {
  let out = String(text ?? "");
  for (const p of patterns || []) {
    try {
      out = out.replace(new RegExp(String(p), "gi"), replacement);
    } catch {
      /* skip bad pattern */
    }
  }
  return out;
};

export { vault };
