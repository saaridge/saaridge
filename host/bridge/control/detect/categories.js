/**
 * Retail-friendly category metadata for content policies.
 * Detector wiring lives in rules.js + catalog apply().
 */

/** @typedef {{ id: string, label: string, description: string }} PolicyCategoryMeta */

/** @type {Record<string, PolicyCategoryMeta[]>} */
export const POLICY_CATEGORIES = {
  "protect-secrets": [
    {
      id: "api_keys",
      label: "API keys & tokens",
      description: "Cloud API keys, JWTs, Bearer tokens, and named secrets.",
    },
    {
      id: "passwords",
      label: "Passwords",
      description: "Password fields and command-line --password / --token flags.",
    },
    {
      id: "private_keys",
      label: "Private keys",
      description: "PEM / OpenSSH private key blocks.",
    },
    {
      id: "db_urls",
      label: "Database URLs",
      description: "Connection strings that embed usernames and passwords.",
    },
    {
      id: "vault_releak",
      label: "Secrets already saved",
      description:
        "Stops assistants from sending plaintext that matches a secret already saved in your vault.",
    },
  ],
  "protect-personal-data": [
    {
      id: "emails",
      label: "Emails",
      description: "Email addresses in files and network text.",
    },
    {
      id: "phones",
      label: "Phone numbers",
      description: "Phone numbers (10–15 digits).",
    },
    {
      id: "ip_addresses",
      label: "IP addresses",
      description: "IPv4 and IPv6 addresses.",
    },
    {
      id: "names_addresses",
      label: "Names & addresses",
      description: "Labeled guest/customer names and home addresses.",
    },
    {
      id: "birth_dates",
      label: "Birth dates",
      description: "Labeled date-of-birth fields.",
    },
    {
      id: "id_docs",
      label: "IDs & passports",
      description: "Labeled passport, national ID, or license numbers.",
    },
    {
      id: "loyalty",
      label: "Loyalty & booking refs",
      description: "Labeled loyalty, booking, or confirmation codes.",
    },
  ],
  "block-payment-data": [
    {
      id: "card_numbers",
      label: "Card numbers",
      description: "Payment card numbers that pass a validity check.",
    },
    {
      id: "cvv",
      label: "Security codes (CVV)",
      description: "Labeled CVV / CVC security codes.",
    },
  ],
  "hide-sensitive-files": [
    {
      id: "env_files",
      label: "Env files",
      description: ".env and .env.* files.",
    },
    {
      id: "key_files",
      label: "Key & cert files",
      description: ".pem, .key, id_rsa, and similar key material.",
    },
    {
      id: "credential_files",
      label: "Credential filenames",
      description: "Files named credentials, secrets, .npmrc, .netrc, etc.",
    },
  ],
  "stop-data-smuggling": [
    {
      id: "encoded_contact",
      label: "Encoded email tricks",
      description: "Emails written as name [at] domain.com to dodge filters.",
    },
    {
      id: "encoded_blobs",
      label: "Hidden encoded blobs",
      description:
        "Long base64 or hex blobs that may hide secrets (files and outbound requests; not inbound web pages).",
    },
    {
      id: "obfuscation",
      label: "Invisible characters",
      description: "Zero-width characters used to sneak text past checks.",
    },
  ],
  "words-i-protect": [
    {
      id: "known_values",
      label: "Words & phrases you add",
      description: "Exact matches for phrases you list below.",
    },
  ],
};

export const defaultCategoryMap = (policyId) => {
  const cats = POLICY_CATEGORIES[policyId] || [];
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const c of cats) out[c.id] = true;
  return out;
};

/**
 * @param {string} policyId
 * @param {Record<string, boolean> | undefined} stored
 * @returns {string[]} enabled category ids
 */
export const resolveEnabledCategories = (policyId, stored) => {
  const defs = POLICY_CATEGORIES[policyId] || [];
  const map = stored && typeof stored === "object" ? stored : {};
  return defs
    .filter((c) => {
      if (Object.prototype.hasOwnProperty.call(map, c.id)) {
        return map[c.id] !== false;
      }
      return true; // missing key → on
    })
    .map((c) => c.id);
};

/**
 * @param {string} policyId
 * @param {Record<string, boolean> | undefined} stored
 */
export const categoriesForUi = (policyId, stored) => {
  const enabled = new Set(resolveEnabledCategories(policyId, stored));
  return (POLICY_CATEGORIES[policyId] || []).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    enabled: enabled.has(c.id),
  }));
};
