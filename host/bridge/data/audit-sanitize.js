/**
 * Sanitize audit/traffic rows so agents never see resolved vault plaintext.
 * CONSTRAINTS: "Returning vault ciphertext or plaintext secret values on any
 * agent-facing API" is forbidden.
 */
const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

const redactHeaders = (headers) => {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) {
      const s = String(v ?? "");
      if (/vault:\/\//i.test(s)) out[k] = s; // markers OK
      else out[k] = "<redacted>";
    } else {
      out[k] = v;
    }
  }
  return out;
};

/**
 * Strip bodies/headers that may contain post-resolve secrets.
 * Safe fields (host, method, op, vaultResolved, …) are kept.
 */
export const sanitizeNetAuditEntry = (entry) => {
  if (!entry || typeof entry !== "object") return entry;
  const vaultish = Boolean(
    entry.vaultResolved ||
      entry.hadVault ||
      (typeof entry.body === "string" && /vault:\/\//i.test(entry.body)),
  );
  const next = { ...entry };
  if (next.headers) next.headers = redactHeaders(next.headers);

  if (vaultish) {
    if (next.body != null && next.body !== "") {
      next.body = "<redacted vault-bearing body>";
      next.bodyRedacted = true;
    }
    // URL query may hold resolved secrets after vault resolve.
    if (typeof next.url === "string" && /vault:\/\//i.test(next.url) === false) {
      try {
        const u = new URL(next.url);
        if ([...u.searchParams.keys()].length) {
          next.url = `${u.origin}${u.pathname}<redacted-query>`;
        }
      } catch {
        /* keep */
      }
    }
  }
  return next;
};

/** Agent-facing view: never return raw net bodies or sensitive headers. */
export const sanitizeAuditForAgent = (entry) => {
  if (!entry || typeof entry !== "object") return entry;
  let next = { ...entry };
  if (next.plane === "net" || String(next.op || "").startsWith("net_")) {
    next = sanitizeNetAuditEntry(next);
    if (next.body != null && next.body !== "" && !next.bodyRedacted) {
      // Non-vault net bodies can still be huge HTML; agents don't need them.
      const s = String(next.body);
      if (s.length > 200) {
        next.body = `<omitted ${s.length} bytes>`;
        next.bodyOmitted = true;
      }
    }
  }
  return next;
};
