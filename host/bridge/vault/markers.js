/**
 * Detect redacted / mediate-required requests (no hostname allowlists).
 */
const VAULT_REF_RE = /vault:\/\/[a-f0-9]+/i;

export const hasVaultRefs = (value) => VAULT_REF_RE.test(String(value ?? ""));

/** True if headers ask for bridge-owned mediate (explicit intent). */
export const hasMediateHeader = (headers = {}) => {
  const raw =
    headers["x-saaridge-mediate"] ||
    headers["X-Saaridge-Mediate"] ||
    headers["x-saaridge-mediate".toLowerCase()];
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
};

/**
 * Classify whether this cleartext request must be MEDIATE (bridge-owned
 * upstream) rather than TUNNEL / blind passthrough.
 */
export const requiresMediate = ({ url, headers, body } = {}) => {
  if (hasMediateHeader(headers || {})) return true;
  if (hasVaultRefs(url)) return true;
  if (hasVaultRefs(body)) return true;
  for (const v of Object.values(headers || {})) {
    if (hasVaultRefs(v)) return true;
  }
  return false;
};

export { VAULT_REF_RE };
