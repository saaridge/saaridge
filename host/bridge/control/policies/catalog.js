/**
 * User-facing content policies (local-only enforcement).
 *
 * Modes (stored in algorithm options.mode):
 *   redact — rewrite only matched spans
 *   block  — deny the entire operation
 *   allow  — free flow (no enforcement)
 *
 * Categories (options.categories): per-policy include/exclude map.
 * Words I Protect also uses options.knownValues: string[].
 */
import {
  detectSecretsByCategories,
  detectVaultReleak,
  detectPaymentsByCategories,
  detectPersonalByCategories,
  detectSmugglingByCategories,
  detectKnownValues,
  pathLooksSensitive,
  pathCategory,
  maskSpans,
} from "../detect/rules.js";
import {
  POLICY_CATEGORIES,
  defaultCategoryMap,
  resolveEnabledCategories,
} from "../detect/categories.js";
import * as vault from "../../vault/index.js";
import {
  isOpaqueRpcContentType,
  shouldProcessNetText,
} from "../../transformers/text.js";

export const MODES = Object.freeze(["redact", "block", "allow"]);

export const POLICY_CATALOG = [
  {
    id: "protect-secrets",
    name: "Protect Secrets",
    description:
      "Stops assistants from seeing API keys, passwords, and private keys.",
    info:
      "Watches files and network text for secrets. Redact replaces them with vault:// markers. Block cancels the whole request. Allow lets matching content through.",
    defaultMode: "redact",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: true,
    categories: POLICY_CATEGORIES["protect-secrets"],
  },
  {
    id: "protect-personal-data",
    name: "Protect Personal Data",
    description:
      "Stops assistants from seeing emails, phones, and labeled personal details.",
    info:
      "Looks for personal details in files and network text. Redact stores values in the vault and shows vault:// markers (with entity in the id). Block cancels the request. Allow lets them through.",
    defaultMode: "redact",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: false,
    categories: POLICY_CATEGORIES["protect-personal-data"],
  },
  {
    id: "block-payment-data",
    name: "Payment Cards",
    description: "Watches for payment card numbers and security codes (CVV).",
    info:
      "Finds card numbers and CVVs. Redact replaces only those values. Block cancels the whole request. Allow lets them through (you choose).",
    defaultMode: "block",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: true,
    categories: POLICY_CATEGORIES["block-payment-data"],
  },
  {
    id: "hide-sensitive-files",
    name: "Hide Sensitive Files",
    description:
      "Hides or blocks access to sensitive filenames (.env, keys, credentials).",
    info:
      "Applies to file lists and reads. Block hides or denies sensitive names. Redact shows a placeholder like [hidden-file]. Allow shows real names.",
    defaultMode: "block",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: false,
    categories: POLICY_CATEGORIES["hide-sensitive-files"],
  },
  {
    id: "stop-data-smuggling",
    name: "Stop Data Smuggling",
    description:
      "Catches sneaky encodings that try to hide personal data or secrets.",
    info:
      "Looks for obfuscated emails, long encoded blobs, and invisible characters. Redact cleans them up. Block cancels the request. Allow skips these checks.",
    defaultMode: "block",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: true,
    categories: POLICY_CATEGORIES["stop-data-smuggling"],
  },
  {
    id: "words-i-protect",
    name: "Words I Protect",
    description: "Protect exact words or phrases you add (names, codes, etc.).",
    info:
      "Add names or phrases that should never reach an assistant. Redact stores them in the vault with vault:// markers. Block cancels the request. Allow turns this list off.",
    defaultMode: "redact",
    allowModes: ["redact", "block", "allow"],
    defaultEnabled: false,
    categories: POLICY_CATEGORIES["words-i-protect"],
    supportsKnownValues: true,
  },
];

export { POLICY_CATEGORIES, defaultCategoryMap, resolveEnabledCategories };

const asText = (data) => {
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
};

const maybeBuffer = (original, text) => {
  if (Buffer.isBuffer(original)) return Buffer.from(String(text), "utf8");
  return text;
};

const getMode = (ctx, policyId, fallback) => {
  const fromMeta = ctx?.meta?.policyModes?.[policyId];
  if (fromMeta && MODES.includes(fromMeta)) return fromMeta;
  return fallback;
};

const getCats = (ctx, policyId) => {
  const fromMeta = ctx?.meta?.policyCategories?.[policyId];
  if (Array.isArray(fromMeta)) return fromMeta;
  return resolveEnabledCategories(policyId, undefined);
};

const getKnown = (ctx, policyId) => {
  const fromMeta = ctx?.meta?.policyKnownValues?.[policyId];
  if (Array.isArray(fromMeta)) return fromMeta;
  return [];
};

const vaultReplaceSpans = (agentId, text, spans) => {
  let out = text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  for (const s of sorted) {
    const value = text.slice(s.start, s.end);
    if (!value) continue;
    const id = vault.put(agentId, {
      kind: "policy-secret",
      name: s.entity || "secret",
      value,
    });
    out = `${out.slice(0, s.start)}vault://${id}${out.slice(s.end)}`;
  }
  return out;
};

const applySpans = ({
  mode,
  policyId,
  agentId,
  data,
  spans,
  redactStyle = "vault",
  ctx,
}) => {
  let fused = spans;
  if (redactStyle === "vault" && ctx?.direction === "egress" && ctx?.agentId) {
    const text = asText(data);
    try {
      const values = Array.isArray(ctx?.meta?.vaultPlainValues)
        ? ctx.meta.vaultPlainValues
        : vault.listPlainValues(ctx.agentId);
      fused = [...spans, ...detectVaultReleak(text, values)];
    } catch {
      /* ignore vault errors */
    }
  }
  if (!fused.length || mode === "allow") {
    return { action: "allow", data };
  }
  if (mode === "block") {
    return {
      action: "deny",
      reason: `Blocked by ${policyId} (${fused[0].entity})`,
      data: "",
    };
  }
  let effectiveMode = mode;
  if (
    mode === "redact" &&
    ctx?.channel === "net" &&
    ctx?.direction === "egress" &&
    fused.length
  ) {
    effectiveMode = "block";
  }
  if (effectiveMode === "block") {
    return {
      action: "deny",
      reason: `Blocked by ${policyId} (${fused[0].entity})`,
      data: "",
    };
  }
  const text = asText(data);
  const next =
    redactStyle === "vault"
      ? vaultReplaceSpans(agentId, text, fused)
      : maskSpans(text, fused);
  return {
    action: next === text ? "allow" : "rewrite",
    data: maybeBuffer(data, next),
  };
};

/**
 * @param {(id: string) => string} getModeForPolicy
 * @param {(id: string) => string[]} [getCategoriesForPolicy]
 * @param {(id: string) => string[]} [getKnownValuesForPolicy]
 */
export const createContentPolicies = (
  getModeForPolicy,
  getCategoriesForPolicy,
  getKnownValuesForPolicy,
) => {
  const modeOf = (id, fallback) => {
    try {
      const m = getModeForPolicy?.(id);
      if (m && MODES.includes(m)) return m;
    } catch {
      /* ignore */
    }
    return fallback;
  };

  const catsOf = (id) => {
    try {
      const c = getCategoriesForPolicy?.(id);
      if (Array.isArray(c) && c.length) return c;
    } catch {
      /* ignore */
    }
    return resolveEnabledCategories(id, undefined);
  };

  const knownOf = (id) => {
    try {
      const k = getKnownValuesForPolicy?.(id);
      if (Array.isArray(k)) return k;
    } catch {
      /* ignore */
    }
    return [];
  };

  const protectSecrets = {
    id: "protect-secrets",
    name: "Protect Secrets",
    description: POLICY_CATALOG.find((p) => p.id === "protect-secrets")
      .description,
    async apply(ctx) {
      const mode = getMode(ctx, this.id, modeOf(this.id, "redact"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel === "fs" && ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }
      const text = asText(ctx.data);
      if (!text) return { action: "allow", data: ctx.data };
      const cats = getCats(ctx, this.id).length
        ? getCats(ctx, this.id)
        : catsOf(this.id);
      const spans = detectSecretsByCategories(text, cats).filter(
        (s) => !text.slice(s.start, s.end).startsWith("vault://"),
      );
      return applySpans({
        mode,
        policyId: this.id,
        agentId: ctx.agentId,
        data: ctx.data,
        spans,
        redactStyle: "vault",
        ctx,
      });
    },
  };

  const protectPersonal = {
    id: "protect-personal-data",
    name: "Protect Personal Data",
    description: POLICY_CATALOG.find((p) => p.id === "protect-personal-data")
      .description,
    async apply(ctx) {
      const mode = getMode(ctx, this.id, modeOf(this.id, "redact"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel === "fs" && ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }
      const text = asText(ctx.data);
      if (!text) return { action: "allow", data: ctx.data };
      const cats = getCats(ctx, this.id).length
        ? getCats(ctx, this.id)
        : catsOf(this.id);
      const spans = detectPersonalByCategories(text, cats);
      return applySpans({
        mode,
        policyId: this.id,
        agentId: ctx.agentId,
        data: ctx.data,
        spans,
        redactStyle: "vault",
        ctx,
      });
    },
  };

  const paymentCards = {
    id: "block-payment-data",
    name: "Payment Cards",
    description: POLICY_CATALOG.find((p) => p.id === "block-payment-data")
      .description,
    async apply(ctx) {
      const mode = getMode(ctx, this.id, modeOf(this.id, "block"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel === "fs" && ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }
      const text = asText(ctx.data);
      if (!text) return { action: "allow", data: ctx.data };
      const cats = getCats(ctx, this.id).length
        ? getCats(ctx, this.id)
        : catsOf(this.id);
      const spans = detectPaymentsByCategories(text, cats);
      return applySpans({
        mode,
        policyId: this.id,
        agentId: ctx.agentId,
        data: ctx.data,
        spans,
        redactStyle: "vault",
        ctx,
      });
    },
  };

  const hideFiles = {
    id: "hide-sensitive-files",
    name: "Hide Sensitive Files",
    description: POLICY_CATALOG.find((p) => p.id === "hide-sensitive-files")
      .description,
    async apply(ctx) {
      const mode = getMode(ctx, this.id, modeOf(this.id, "block"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel !== "fs") return { action: "allow", data: ctx.data };
      const cats = new Set(
        getCats(ctx, this.id).length
          ? getCats(ctx, this.id)
          : catsOf(this.id),
      );

      // List filtering is handled in control/lib.js (needs entries array).
      if (ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }

      if (!pathLooksSensitive(ctx.path || "", cats)) {
        return { action: "allow", data: ctx.data };
      }

      if (mode === "block") {
        return {
          action: "deny",
          reason: "Blocked by Hide Sensitive Files",
          data: "",
        };
      }
      // redact — placeholder body so agent does not see file contents
      return {
        action: "rewrite",
        data: maybeBuffer(ctx.data, "[hidden-file]"),
        reason: "redacted-sensitive-file",
      };
    },
  };

  const stopSmuggling = {
    id: "stop-data-smuggling",
    name: "Stop Data Smuggling",
    description: POLICY_CATALOG.find((p) => p.id === "stop-data-smuggling")
      .description,
    async apply(ctx) {
      let mode = getMode(ctx, this.id, modeOf(this.id, "block"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel === "fs" && ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }
      const text = asText(ctx.data);
      if (!text) return { action: "allow", data: ctx.data };
      let cats = getCats(ctx, this.id).length
        ? getCats(ctx, this.id)
        : catsOf(this.id);
      // Web responses embed emails, protobuf/base64, marketing copy, etc.
      // encoded_blobs / encoded_contact are for agent FS / egress smuggling —
      // not inbound pages (block mode would blank entire SPA HTML).
      if (ctx.channel === "net" && ctx.direction === "ingress") {
        cats = cats.filter(
          (c) => c !== "encoded_blobs" && c !== "encoded_contact",
        );
        // Never fail-closed blank an inbound page; redact residual hits only.
        if (mode === "block") mode = "redact";
      }
      // Opaque egress (protobuf / octet-stream / Chrome update RPCs): binary
      // non-goal — do not treat as text smuggling. Generic content-type check,
      // not a hostname allowlist (CONSTRAINTS).
      if (ctx.channel === "net" && ctx.direction === "egress") {
        const headers = ctx.headers || ctx.meta?.headers || {};
        const ctype = String(
          headers["content-type"] || headers["Content-Type"] || "",
        );
        if (
          isOpaqueRpcContentType(ctype) ||
          /octet-stream|protobuf|x-protobuf|grpc/i.test(ctype) ||
          !shouldProcessNetText(headers, ctx.data)
        ) {
          cats = cats.filter((c) => c !== "encoded_blobs");
        }
      }
      if (!cats.length) return { action: "allow", data: ctx.data };
      const spans = detectSmugglingByCategories(text, cats);
      return applySpans({
        mode,
        policyId: this.id,
        agentId: ctx.agentId,
        data: ctx.data,
        spans,
        redactStyle: "vault",
        ctx,
      });
    },
  };

  const wordsIProtect = {
    id: "words-i-protect",
    name: "Words I Protect",
    description: POLICY_CATALOG.find((p) => p.id === "words-i-protect")
      .description,
    async apply(ctx) {
      const mode = getMode(ctx, this.id, modeOf(this.id, "redact"));
      if (mode === "allow") return { action: "allow", data: ctx.data };
      if (ctx.channel === "fs" && ctx.meta?.list) {
        return { action: "allow", data: ctx.data };
      }
      const cats = getCats(ctx, this.id).length
        ? getCats(ctx, this.id)
        : catsOf(this.id);
      if (!cats.includes("known_values")) {
        return { action: "allow", data: ctx.data };
      }
      const phrases = getKnown(ctx, this.id).length
        ? getKnown(ctx, this.id)
        : knownOf(this.id);
      const text = asText(ctx.data);
      if (!text || !phrases.length) return { action: "allow", data: ctx.data };
      const spans = detectKnownValues(text, phrases);
      return applySpans({
        mode,
        policyId: this.id,
        agentId: ctx.agentId,
        data: ctx.data,
        spans,
        redactStyle: "vault",
        ctx,
      });
    },
  };

  return [
    protectSecrets,
    protectPersonal,
    paymentCards,
    hideFiles,
    stopSmuggling,
    wordsIProtect,
  ];
};

/** Helper for control/lib.js list filtering / redact. */
export const sensitiveNameAction = ({
  name,
  mode,
  enabledCategories,
}) => {
  if (mode === "allow") return { action: "keep", name };
  if (!pathLooksSensitive(name, enabledCategories)) {
    return { action: "keep", name };
  }
  if (mode === "block") return { action: "hide", name };
  // redact
  return { action: "rewrite", name: "[hidden-file]" };
};

export { pathCategory, pathLooksSensitive };
