/**
 * Local-only content detectors (no network).
 * Spans: { start, end, entity, severity, category? }.
 */

const EMAIL =
  /(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,63}(?![\w-])/gi;

// Only genuinely disguised forms. A *bare* `@` belongs to EMAIL, which Protect
// Personal Data owns: matching it here made Stop Data Smuggling redact ordinary
// emails too, so setting Protect Personal Data to Allow had no visible effect.
// A spaced `name @ domain.com` is still a filter dodge, so `@` counts only when
// whitespace sits next to it — hence `\s@` / `@\s` rather than plain `@`.
const EMAIL_OBFUSCATED =
  /(?<![\w.+-])([A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})\s*(?:\[at\]|\(at\)|\sat\s|\s@|@\s)\s*((?:[A-Z0-9-]+\.)+[A-Z]{2,63})(?![\w-])/gi;

const PHONE =
  /(?<!\w)(?:\+\d{1,3}[\s().-]?)?(?:\(?\d{1,4}\)?[\s.-]?){2,6}\d{1,4}(?!\w)/g;

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|::(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})(?![\w:])/gi;

const JWT =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

const OPENAI_KEY =
  /(?<![A-Za-z0-9])(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/g;

const GITHUB_TOKEN =
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})(?![A-Za-z0-9_])/g;

const AWS_KEY = /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g;

const VENDOR_KEY =
  /(?<![A-Za-z0-9_-])(?:AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,})(?![A-Za-z0-9_-])/g;

const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/gi;

const DB_URL =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|mssql):\/\/[^:/\s@]+:[^@\s/]+@[^\s"'<>]+/gi;

const NAMED_SECRET =
  /(?<!\w)["']?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)["']?\s*(?:=|:)\s*["']?([A-Za-z0-9+/_.=-]{8,})["']?/gi;

const PASSWORD =
  /(?<![\w-])["']?(?:[A-Za-z][A-Za-z0-9]{0,31}[_-])?(?:password|passwd|pwd)["']?\s*(?:=|:|\bis\b)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;}\]]{4,})/gi;

const CLI_SECRET =
  /(?:^|\s)(?:--(?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token)|-p)\s*(?:=|\s+)(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s]{4,})/gi;

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]{16,}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;

const CVV =
  /(?<!\w)["']?(?:cvv2?|cvc2?|card[_ -]?security[_ -]?code)["']?\s*(?:=|:)\s*["']?(\d{3,4})\b/gi;

// Separators: whitespace / hyphen only. Do NOT allow `.` or `/` — those match
// SVG path floats and dates and cause Luhn false positives that wipe pages
// under block-payment-data (e.g. lichess.org homepage SVG).
const CARD_CANDIDATE =
  /(?<![A-Za-z0-9])\d(?:(?:[^\S\r\n]|[_-]){0,3}\d){12,18}(?![A-Za-z0-9])/g;

const PERSON_LABELED =
  /(?<!\w)["']?(?:guest(?:[_ -]?name)?|passenger[_ -]?name|customer[_ -]?name|full[_ -]?name)["']?\s*(?:=|:)\s*["']?([^\W\d_](?:[^\W\d_]|['’\- ]){2,80})/gi;

const ADDRESS_LABELED =
  /(?<!\w)["']?(?:home|residential|private|guest)[_ -]+address["']?\s*(?:=|:)\s*["']?(\d{1,6}\s+[A-Za-z0-9.'’ \-]{2,70}\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?)(?:[ \t,]+[A-Za-z0-9.'’ \-]{2,40})?)/gi;

const DOB_LABELED =
  /(?<!\w)["']?(?:date[_ -]+of[_ -]+birth|birth[_ -]+date|dob)["']?\s*(?:=|:)\s*["']?((?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}))\b/gi;

const ID_LABELED =
  /(?<!\w)["']?(?:passport(?:[_ -]?number)?|national[_ -]?id|driver[_ -]?license|ssn|social[_ -]?security)["']?\s*(?:=|:)\s*["']?([A-Za-z0-9][A-Za-z0-9 \-]{4,32})/gi;

const LOYALTY_LABELED =
  /(?<!\w)["']?(?:loyalty[_ -]?(?:number|id)|booking[_ -]?(?:ref|reference|code)|confirmation[_ -]?(?:code|number)|account[_ -]?number)["']?\s*(?:=|:)\s*["']?([A-Za-z0-9][A-Za-z0-9\-]{3,32})/gi;

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

// Min 48 keeps short JWTs/keys out of this catch-all; still needs plausibility
// filters in detectEncodedBlobs (FEN / paths / SVG look like base64 alphabet).
const BASE64_BLOB =
  /(?<![A-Za-z0-9+/=])(?:[A-Za-z0-9+/]{48,}={0,2})(?![A-Za-z0-9+/=])/g;

const HEX_BLOB =
  /(?<![A-Fa-f0-9])(?:0x)?(?:[A-Fa-f0-9]{48,})(?![A-Fa-f0-9])/g;

const luhnOk = (digits) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** Major-scheme IIN + length — cuts random Luhn hits in SVG/CSS/JSON numbers. */
const looksLikePan = (digits) => {
  const d = String(digits || "");
  const len = d.length;
  if (len < 13 || len > 19) return false;
  // Visa
  if (d[0] === "4" && (len === 13 || len === 16 || len === 19)) return true;
  // Mastercard 51–55 / 2221–2720
  if (/^5[1-5]/.test(d) && len === 16) return true;
  if (
    len === 16 &&
    d.startsWith("2") &&
    Number(d.slice(0, 4)) >= 2221 &&
    Number(d.slice(0, 4)) <= 2720
  ) {
    return true;
  }
  // Amex
  if (/^3[47]/.test(d) && len === 15) return true;
  // Discover
  if (/^(6011|65|64[4-9])/.test(d) && len === 16) return true;
  // Diners Club
  if (/^3(?:0[0-5]|[68])/.test(d) && len === 14) return true;
  // JCB
  if (/^35(?:2[89]|[3-8]\d)/.test(d) && len === 16) return true;
  // UnionPay (common lengths)
  if (d[0] === "6" && (len === 16 || len === 17 || len === 18 || len === 19)) {
    return true;
  }
  return false;
};

/**
 * Real PANs are contiguous or grouped like 4-4-4-4 / 4-6-5.
 * Reject SVG/path soups of 1–2 digit crumbs joined by spaces/hyphens
 * (e.g. lichess piece SVG "23-1 2-1 0-4 1-4-4…").
 */
const hasCardLikeGrouping = (raw) => {
  const s = String(raw || "");
  if (!/[\s_-]/.test(s)) return true; // contiguous digits
  const groups = s
    .split(/[\s_-]+/)
    .map((g) => g.replace(/\D/g, ""))
    .filter(Boolean);
  if (groups.length < 2) return true;
  const tiny = groups.filter((g) => g.length <= 2).length;
  if (tiny >= 2) return false;
  const plausible = groups.filter((g) => g.length >= 3 && g.length <= 7).length;
  return plausible >= 2 && plausible >= groups.length - 1;
};

export const pushMatches = (
  spans,
  text,
  re,
  entity,
  severity = "high",
  group = 0,
  category = null,
) => {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const captured = group > 0 ? m[group] : null;
    let start = m.index;
    let end = m.index + full.length;
    if (captured && full.includes(captured)) {
      const off = full.indexOf(captured);
      start = m.index + off;
      end = start + captured.length;
    }
    if (end > start) {
      const span = { start, end, entity, severity };
      if (category) span.category = category;
      spans.push(span);
    }
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
};

const digitsOnly = (s) => String(s).replace(/\D/g, "");

const phonePlausible = (raw) => {
  const d = digitsOnly(raw);
  return d.length >= 10 && d.length <= 15;
};

const dedupe = (spans) => {
  const key = (s) => `${s.start}:${s.end}:${s.entity}`;
  const seen = new Set();
  const out = [];
  for (const s of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const k = key(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};

/** Fuse overlaps: keep longer / higher-severity spans. */
export const fuseSpans = (spans) => {
  const rank = { critical: 3, high: 2, medium: 1, low: 0 };
  const sorted = [...spans].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      (rank[b.severity] || 0) - (rank[a.severity] || 0),
  );
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (!last || s.start >= last.end) {
      out.push({ ...s });
      continue;
    }
    const preferNew =
      (rank[s.severity] || 0) > (rank[last.severity] || 0) ||
      ((rank[s.severity] || 0) === (rank[last.severity] || 0) &&
        s.end - s.start > last.end - last.start);
    if (preferNew) {
      out[out.length - 1] = { ...s };
    }
  }
  return out;
};

export const filterByCategories = (spans, enabledSet) => {
  if (!enabledSet) return spans;
  return spans.filter((s) => {
    if (!s.category) return true;
    return enabledSet.has(s.category);
  });
};

/** API keys / tokens category */
export const detectApiKeys = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, JWT, "CREDENTIAL", "critical", 0, "api_keys");
  pushMatches(spans, t, OPENAI_KEY, "CREDENTIAL", "critical", 0, "api_keys");
  pushMatches(spans, t, GITHUB_TOKEN, "CREDENTIAL", "critical", 0, "api_keys");
  pushMatches(spans, t, AWS_KEY, "CREDENTIAL", "critical", 0, "api_keys");
  pushMatches(spans, t, VENDOR_KEY, "CREDENTIAL", "critical", 0, "api_keys");
  pushMatches(spans, t, BEARER, "CREDENTIAL", "critical", 1, "api_keys");
  pushMatches(spans, t, NAMED_SECRET, "CREDENTIAL", "critical", 1, "api_keys");
  return fuseSpans(dedupe(spans));
};

export const detectPasswords = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, PASSWORD, "CREDENTIAL", "critical", 0, "passwords");
  pushMatches(spans, t, CLI_SECRET, "CREDENTIAL", "critical", 0, "passwords");
  return fuseSpans(dedupe(spans));
};

export const detectPrivateKeys = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, PRIVATE_KEY, "PRIVATE_KEY", "critical", 0, "private_keys");
  return fuseSpans(dedupe(spans));
};

export const detectDbUrls = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, DB_URL, "CREDENTIAL", "critical", 0, "db_urls");
  return fuseSpans(dedupe(spans));
};

/** Combined secrets (all categories) — backward compatible. */
export const detectSecrets = (text) =>
  fuseSpans(
    dedupe([
      ...detectApiKeys(text),
      ...detectPasswords(text),
      ...detectPrivateKeys(text),
      ...detectDbUrls(text),
    ]),
  );

export const detectSecretsByCategories = (text, enabledCategories) => {
  const enabled = new Set(enabledCategories || []);
  const parts = [];
  if (enabled.has("api_keys")) parts.push(...detectApiKeys(text));
  if (enabled.has("passwords")) parts.push(...detectPasswords(text));
  if (enabled.has("private_keys")) parts.push(...detectPrivateKeys(text));
  if (enabled.has("db_urls")) parts.push(...detectDbUrls(text));
  return fuseSpans(dedupe(parts));
};

/**
 * Find plaintext that matches already-vaulted secret values (egress leak).
 * @param {string} text
 * @param {string[]} values
 */
export const detectVaultReleak = (text, values = []) => {
  const t = String(text || "");
  const spans = [];
  for (const raw of values) {
    const v = String(raw || "");
    if (v.length < 6) continue;
    let idx = 0;
    const lower = t.toLowerCase();
    const needle = v.toLowerCase();
    while (idx < t.length) {
      const found = lower.indexOf(needle, idx);
      if (found < 0) break;
      spans.push({
        start: found,
        end: found + v.length,
        entity: "CREDENTIAL",
        severity: "critical",
        category: "vault_releak",
      });
      idx = found + v.length;
    }
  }
  return fuseSpans(dedupe(spans));
};

export const detectCardNumbers = (text) => {
  const spans = [];
  const t = String(text || "");
  CARD_CANDIDATE.lastIndex = 0;
  let m;
  while ((m = CARD_CANDIDATE.exec(t)) !== null) {
    const raw = m[0];
    // Decimal / date separators are never PAN formatting.
    if (/[./]/.test(raw)) continue;
    if (!hasCardLikeGrouping(raw)) continue;
    const digits = digitsOnly(raw);
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnOk(digits)) continue;
    if (!looksLikePan(digits)) continue;
    spans.push({
      start: m.index,
      end: m.index + raw.length,
      entity: "PAYMENT_CARD",
      severity: "critical",
      category: "card_numbers",
    });
  }
  return fuseSpans(dedupe(spans));
};

export const detectCvv = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, CVV, "CVV", "critical", 1, "cvv");
  return fuseSpans(dedupe(spans));
};

export const detectPayments = (text) =>
  fuseSpans(dedupe([...detectCardNumbers(text), ...detectCvv(text)]));

export const detectPaymentsByCategories = (text, enabledCategories) => {
  const enabled = new Set(enabledCategories || []);
  const parts = [];
  if (enabled.has("card_numbers")) parts.push(...detectCardNumbers(text));
  if (enabled.has("cvv")) parts.push(...detectCvv(text));
  return fuseSpans(dedupe(parts));
};

export const detectEmails = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, EMAIL, "EMAIL", "high", 0, "emails");
  return fuseSpans(dedupe(spans));
};

export const detectPhones = (text) => {
  const spans = [];
  const t = String(text || "");
  PHONE.lastIndex = 0;
  let m;
  while ((m = PHONE.exec(t)) !== null) {
    const raw = m[0];
    // SVG/CSS path floats (many '.') are not phone numbers.
    if ((raw.match(/\./g) || []).length >= 2) continue;
    if (!phonePlausible(raw)) continue;
    spans.push({
      start: m.index,
      end: m.index + raw.length,
      entity: "PHONE",
      severity: "high",
      category: "phones",
    });
  }
  return fuseSpans(dedupe(spans));
};

export const detectIps = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, IPV4, "IP_ADDRESS", "medium", 0, "ip_addresses");
  pushMatches(spans, t, IPV6, "IP_ADDRESS", "medium", 0, "ip_addresses");
  return fuseSpans(dedupe(spans));
};

export const detectNamesAddresses = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, PERSON_LABELED, "PERSON", "high", 1, "names_addresses");
  pushMatches(
    spans,
    t,
    ADDRESS_LABELED,
    "PRIVATE_ADDRESS",
    "high",
    1,
    "names_addresses",
  );
  return fuseSpans(dedupe(spans));
};

export const detectBirthDates = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, DOB_LABELED, "DATE", "medium", 1, "birth_dates");
  return fuseSpans(dedupe(spans));
};

export const detectIdDocs = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, ID_LABELED, "ID_DOC", "high", 1, "id_docs");
  return fuseSpans(dedupe(spans));
};

export const detectLoyalty = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(spans, t, LOYALTY_LABELED, "LOYALTY", "medium", 1, "loyalty");
  return fuseSpans(dedupe(spans));
};

export const detectPersonal = (text) =>
  fuseSpans(
    dedupe([
      ...detectEmails(text),
      ...detectPhones(text),
      ...detectIps(text),
      ...detectNamesAddresses(text),
      ...detectBirthDates(text),
      ...detectIdDocs(text),
      ...detectLoyalty(text),
    ]),
  );

export const detectPersonalByCategories = (text, enabledCategories) => {
  const enabled = new Set(enabledCategories || []);
  const parts = [];
  if (enabled.has("emails")) parts.push(...detectEmails(text));
  if (enabled.has("phones")) parts.push(...detectPhones(text));
  if (enabled.has("ip_addresses")) parts.push(...detectIps(text));
  if (enabled.has("names_addresses")) parts.push(...detectNamesAddresses(text));
  if (enabled.has("birth_dates")) parts.push(...detectBirthDates(text));
  if (enabled.has("id_docs")) parts.push(...detectIdDocs(text));
  if (enabled.has("loyalty")) parts.push(...detectLoyalty(text));
  return fuseSpans(dedupe(parts));
};

/** Encoded / obfuscated contact tricks */
export const detectEncodedContact = (text) => {
  const spans = [];
  const t = String(text || "");
  pushMatches(
    spans,
    t,
    EMAIL_OBFUSCATED,
    "EMAIL",
    "high",
    0,
    "encoded_contact",
  );
  return fuseSpans(dedupe(spans));
};

/** Chess FEN / URL paths: many short `/`-separated chunks ≠ opaque base64. */
const looksLikeSlashDelimitedText = (raw) => {
  if (!String(raw).includes("/")) return false;
  const parts = String(raw).split("/");
  if (parts.length < 3) return false;
  const short = parts.filter((p) => p.length > 0 && p.length <= 12).length;
  return short >= 3 && short / parts.length >= 0.5;
};

const looksLikeOpaqueBase64 = (raw) => {
  const s = String(raw || "");
  if (s.length < 48) return false;
  if (looksLikeSlashDelimitedText(s)) return false;
  // Padded base64 is a strong signal even at moderate length.
  if (/=+$/.test(s)) return true;
  // Unpadded: demand longer runs + mixed alphabet (avoids FEN/CSS/ids).
  if (s.length < 80) return false;
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /\d/.test(s);
  return hasUpper && hasLower && hasDigit;
};

export const detectEncodedBlobs = (text) => {
  const spans = [];
  const t = String(text || "");
  BASE64_BLOB.lastIndex = 0;
  let m;
  while ((m = BASE64_BLOB.exec(t)) !== null) {
    const raw = m[0];
    // Skip JWTs (caught by secret detectors); skip path/FEN false positives.
    if (/^eyJ/.test(raw)) continue;
    if (!looksLikeOpaqueBase64(raw)) continue;
    spans.push({
      start: m.index,
      end: m.index + raw.length,
      entity: "ENCODED_BLOB",
      severity: "medium",
      category: "encoded_blobs",
    });
  }
  pushMatches(spans, t, HEX_BLOB, "ENCODED_BLOB", "medium", 0, "encoded_blobs");
  return fuseSpans(dedupe(spans));
};

export const detectObfuscation = (text) => {
  const spans = [];
  const t = String(text || "");
  ZERO_WIDTH.lastIndex = 0;
  let m;
  while ((m = ZERO_WIDTH.exec(t)) !== null) {
    // UTF-8 BOM (U+FEFF) at the start of CSS/JS/HTML is normal, not smuggling.
    if (m.index === 0 && m[0] === "\uFEFF") continue;
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      entity: "OBFUSCATION",
      severity: "medium",
      category: "obfuscation",
    });
  }
  return fuseSpans(dedupe(spans));
};

export const detectSmugglingByCategories = (text, enabledCategories) => {
  const enabled = new Set(enabledCategories || []);
  const parts = [];
  if (enabled.has("encoded_contact")) parts.push(...detectEncodedContact(text));
  if (enabled.has("encoded_blobs")) parts.push(...detectEncodedBlobs(text));
  if (enabled.has("obfuscation")) parts.push(...detectObfuscation(text));
  return fuseSpans(dedupe(parts));
};

/**
 * Exact / whole-word known phrases (case-insensitive). Min length 3.
 * @param {string} text
 * @param {string[]} phrases
 */
export const detectKnownValues = (text, phrases = []) => {
  const t = String(text || "");
  const spans = [];
  for (const raw of phrases) {
    const phrase = String(raw || "").trim();
    if (phrase.length < 3) continue;
    const lower = t.toLowerCase();
    const needle = phrase.toLowerCase();
    let idx = 0;
    while (idx < t.length) {
      const found = lower.indexOf(needle, idx);
      if (found < 0) break;
      const before = found === 0 ? " " : t[found - 1];
      const after =
        found + phrase.length >= t.length ? " " : t[found + phrase.length];
      const boundary = /[\s,.;:!?()[\]{}"'/\\<>]/;
      const whole =
        boundary.test(before) && boundary.test(after);
      // Allow substring for multi-word phrases; for single tokens prefer word boundary
      const ok =
        phrase.includes(" ") || phrase.includes("-")
          ? true
          : whole || (found === 0 && boundary.test(after));
      if (ok || phrase.includes(" ")) {
        spans.push({
          start: found,
          end: found + phrase.length,
          entity: "PROTECTED",
          severity: "high",
          category: "known_values",
        });
      }
      idx = found + phrase.length;
    }
  }
  return fuseSpans(dedupe(spans));
};

const PATH_ENV =
  /(?:^|\/)(?:\.env(?:\..+)?)(?:$|\/)/i;
const PATH_KEYS =
  /(?:^|\/)(?:.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)(?:$|\/)/i;
const PATH_CREDS =
  /(?:^|\/)(?:credentials|\.npmrc|\.netrc|secrets?(?:\.json)?|wallet\.dat)(?:$|\/)/i;

export const pathCategory = (filePath) => {
  const p = String(filePath || "").replace(/\\/g, "/");
  const base = p.split("/").pop() || p;
  if (PATH_ENV.test(p) || PATH_ENV.test(base)) return "env_files";
  if (PATH_KEYS.test(p) || PATH_KEYS.test(base)) return "key_files";
  if (PATH_CREDS.test(p) || PATH_CREDS.test(base)) return "credential_files";
  return null;
};

export const pathLooksSensitive = (filePath, enabledCategories = null) => {
  const cat = pathCategory(filePath);
  if (!cat) return false;
  if (!enabledCategories) return true;
  return enabledCategories.has
    ? enabledCategories.has(cat)
    : new Set(enabledCategories).has(cat);
};

export const MASK = {
  CREDENTIAL: "[SECRET]",
  PRIVATE_KEY: "[PRIVATE_KEY]",
  PAYMENT_CARD: "[CARD]",
  CVV: "[CVV]",
  EMAIL: "[EMAIL]",
  PHONE: "[PHONE]",
  IP_ADDRESS: "[IP]",
  PERSON: "[NAME]",
  PRIVATE_ADDRESS: "[ADDRESS]",
  DATE: "[DATE]",
  ID_DOC: "[ID]",
  LOYALTY: "[REF]",
  ENCODED_BLOB: "[ENCODED]",
  OBFUSCATION: "",
  PROTECTED: "[PROTECTED]",
};

export const maskSpans = (text, spans) => {
  let out = String(text || "");
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  for (const s of sorted) {
    const token =
      Object.prototype.hasOwnProperty.call(MASK, s.entity)
        ? MASK[s.entity]
        : "[REDACTED]";
    out = out.slice(0, s.start) + token + out.slice(s.end);
  }
  return out;
};
