/**
 * Host-only AI policy admin + local content-policy registration.
 * Config under state/private (never FUSE / container mounted).
 */
import fs from "node:fs";
import path from "node:path";
import {
  AlgorithmRegistry,
  PolicyEngine,
} from "@ai-policy-engine/core";
import { PRIVATE_STATE_DIR } from "./paths.js";
import {
  POLICY_CATALOG,
  MODES,
  createContentPolicies,
  defaultCategoryMap,
  resolveEnabledCategories,
} from "../bridge/control/policies/catalog.js";
import { categoriesForUi } from "../bridge/control/detect/categories.js";
import * as fsMemo from "../bridge/data/fs-memo.js";
import * as vault from "../bridge/vault/index.js";

export const AI_POLICY_CONFIG_PATH =
  process.env.AI_POLICY_CONFIG ||
  path.join(PRIVATE_STATE_DIR, "ai-policies.json");

let engine = null;
let policyConfigMtimeMs = 0;

/** Reload policy store only when ai-policies.json changed (hot read path). */
export const syncPolicyFromDisk = () => {
  const e = getPolicyEngine();
  try {
    const st = fs.statSync(AI_POLICY_CONFIG_PATH);
    if (st.mtimeMs !== policyConfigMtimeMs) {
      e.reload();
      policyConfigMtimeMs = st.mtimeMs;
    }
  } catch {
    if (policyConfigMtimeMs === 0) {
      e.reload();
      policyConfigMtimeMs = Date.now();
    }
  }
};

const notePolicyConfigWritten = () => {
  try {
    policyConfigMtimeMs = fs.statSync(AI_POLICY_CONFIG_PATH).mtimeMs;
  } catch {
    policyConfigMtimeMs = Date.now();
  }
};

/** Mediated file reads cache transformed bytes — bust when policy changes. */
export const invalidateMediationCaches = () => {
  try {
    fsMemo.bustAll("policy");
  } catch {
    /* ignore */
  }
};

const getModeForPolicy = (policyId) => {
  const e = getPolicyEngine();
  const entry = e.store.algorithms?.[policyId];
  const mode = entry?.options?.mode;
  if (typeof mode === "string" && MODES.includes(mode)) return mode;
  const meta = POLICY_CATALOG.find((p) => p.id === policyId);
  return meta?.defaultMode || "redact";
};

const getCategoriesForPolicy = (policyId) => {
  const e = getPolicyEngine();
  const entry = e.store.algorithms?.[policyId];
  return resolveEnabledCategories(policyId, entry?.options?.categories);
};

const getKnownValuesForPolicy = (policyId) => {
  const e = getPolicyEngine();
  const entry = e.store.algorithms?.[policyId];
  const raw = entry?.options?.knownValues;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s || "").trim()).filter((s) => s.length >= 3);
};

export const getEnabledCategories = (policyId) =>
  getCategoriesForPolicy(policyId);

export const getPolicyKnownValues = (policyId) =>
  getKnownValuesForPolicy(policyId);

export const getPolicyEngine = () => {
  if (engine) return engine;
  const registry = new AlgorithmRegistry();
  for (const algo of createContentPolicies(
    getModeForPolicy,
    getCategoriesForPolicy,
    getKnownValuesForPolicy,
  )) {
    registry.register(algo);
  }
  engine = new PolicyEngine({
    registry,
    configPath: AI_POLICY_CONFIG_PATH,
  });
  ensureDefaultPolicies(engine);
  return engine;
};

/** First-run defaults + migrate legacy stubs / category maps. */
const ensureDefaultPolicies = (e) => {
  e.reload();
  let changed = false;
  const algorithms = { ...e.store.algorithms };
  for (const p of POLICY_CATALOG) {
    if (!algorithms[p.id]) {
      algorithms[p.id] = {
        enabledGlobally: Boolean(p.defaultEnabled),
        options: {
          mode: p.defaultMode,
          categories: defaultCategoryMap(p.id),
          ...(p.supportsKnownValues ? { knownValues: [] } : {}),
        },
      };
      changed = true;
    } else {
      const opts = { ...(algorithms[p.id].options || {}) };
      if (!opts.mode) {
        opts.mode = p.defaultMode;
        changed = true;
      }
      const allowedModes = p.allowModes || MODES;
      if (opts.mode && !allowedModes.includes(opts.mode)) {
        opts.mode = p.defaultMode;
        changed = true;
      }
      if (!opts.categories || typeof opts.categories !== "object") {
        opts.categories = defaultCategoryMap(p.id);
        changed = true;
      } else {
        // Fill missing category keys as enabled
        const defs = defaultCategoryMap(p.id);
        for (const [cid, on] of Object.entries(defs)) {
          if (!Object.prototype.hasOwnProperty.call(opts.categories, cid)) {
            opts.categories = { ...opts.categories, [cid]: on };
            changed = true;
          }
        }
      }
      if (p.supportsKnownValues && !Array.isArray(opts.knownValues)) {
        opts.knownValues = [];
        changed = true;
      }
      algorithms[p.id] = { ...algorithms[p.id], options: opts };
    }
  }
  for (const legacy of ["pii.v1", "secrets.v1"]) {
    if (algorithms[legacy]) {
      delete algorithms[legacy];
      changed = true;
    }
  }

  const LEGACY_MAP = {
    "pii.v1": "protect-personal-data",
    "secrets.v1": "protect-secrets",
  };
  const agents = { ...(e.store.agents || {}) };
  for (const [agentId, binding] of Object.entries(agents)) {
    let agentChanged = false;
    const active = Array.isArray(binding?.activeAlgorithms)
      ? [...binding.activeAlgorithms]
      : [];
    const overrides = { ...(binding?.overrides || {}) };
    const nextActive = [];
    for (const id of active) {
      const mapped = LEGACY_MAP[id];
      if (mapped) {
        if (!nextActive.includes(mapped)) nextActive.push(mapped);
        agentChanged = true;
      } else if (!LEGACY_MAP[id]) {
        nextActive.push(id);
      }
    }
    for (const [id, val] of Object.entries(overrides)) {
      const mapped = LEGACY_MAP[id];
      if (mapped) {
        overrides[mapped] = val;
        delete overrides[id];
        agentChanged = true;
      }
    }
    for (const id of Object.keys(LEGACY_MAP)) {
      if (Object.prototype.hasOwnProperty.call(overrides, id)) {
        delete overrides[id];
        agentChanged = true;
      }
    }
    const cleanedActive = nextActive.filter((id) => !LEGACY_MAP[id]);
    if (
      agentChanged ||
      cleanedActive.length !== active.length ||
      cleanedActive.some((id, i) => id !== active[i])
    ) {
      agents[agentId] = {
        activeAlgorithms: cleanedActive,
        overrides,
      };
      changed = true;
    }
  }

  if (changed) {
    e.store = { ...e.store, algorithms, agents };
    e.persist();
  }
};

export const resetPolicyEngine = () => {
  engine = null;
};

export const listPolicyCatalog = () =>
  POLICY_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    info: p.info || p.description,
    allowModes: p.allowModes,
    defaultMode: p.defaultMode,
    categories: (p.categories || []).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
    })),
    supportsKnownValues: Boolean(p.supportsKnownValues),
    knownValuesKind: p.knownValuesKind || null,
  }));

export const listPolicyAlgorithms = () => {
  const e = getPolicyEngine();
  e.reload();
  return e.listAlgorithms();
};

export const listPolicyAgents = () => {
  const e = getPolicyEngine();
  e.reload();
  return e.listAgents();
};

export const getPolicyAgent = (agentId) => {
  const e = getPolicyEngine();
  e.reload();
  return e.getAgentBinding(agentId);
};

export const ensurePolicyAgent = (agentId) => {
  const e = getPolicyEngine();
  e.reload();
  return e.ensureAgent(agentId);
};

export const enablePolicy = (agentId, algorithmId) => {
  const e = getPolicyEngine();
  e.reload();
  e.enable(agentId, algorithmId);
  return e.getAgentBinding(agentId);
};

export const disablePolicy = (agentId, algorithmId) => {
  const e = getPolicyEngine();
  e.reload();
  e.disable(agentId, algorithmId);
  return e.getAgentBinding(agentId);
};

export const setPolicyOverride = (agentId, algorithmId, mode) => {
  const e = getPolicyEngine();
  e.reload();
  return e.setOverride(agentId, algorithmId, mode);
};

const enrichPolicy = (meta, a) => {
  const mode = getModeForPolicy(meta.id);
  const entry = getPolicyEngine().store.algorithms?.[meta.id];
  const cats = categoriesForUi(meta.id, entry?.options?.categories);
  const customized = cats.some((c) => !c.enabled);
  return {
    ...a,
    name: meta.name,
    description: meta.description,
    info: meta.info || meta.description,
    mode,
    allowModes: meta.allowModes || ["redact", "block", "allow"],
    categories: cats,
    customized,
    supportsKnownValues: Boolean(meta.supportsKnownValues),
    knownValuesKind: meta.knownValuesKind || null,
    knownValues: meta.supportsKnownValues
      ? getKnownValuesForPolicy(meta.id)
      : undefined,
  };
};

export const listGlobalPolicies = () => {
  syncPolicyFromDisk();
  const e = getPolicyEngine();
  const byId = Object.fromEntries(e.listGlobal().map((a) => [a.id, a]));
  return POLICY_CATALOG.map((meta) => {
    const a = byId[meta.id] || {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      enabledGlobally: Boolean(meta.defaultEnabled),
    };
    return enrichPolicy(meta, a);
  });
};

export const setGlobalPolicy = (algorithmId, enabled) => {
  const e = getPolicyEngine();
  e.reload();
  e.setGlobal(algorithmId, enabled);
  notePolicyConfigWritten();
  invalidateMediationCaches();
  return listGlobalPolicies();
};

/**
 * Set enforcement mode for a policy: redact | block | allow
 */
export const setPolicyMode = (algorithmId, mode) => {
  const meta = POLICY_CATALOG.find((p) => p.id === algorithmId);
  if (!meta) {
    const err = new Error(`Unknown policy: ${algorithmId}`);
    err.code = "UNKNOWN_ALGORITHM";
    throw err;
  }
  const allowed = meta.allowModes || MODES;
  if (!allowed.includes(mode)) {
    const err = new Error(`Mode "${mode}" is not allowed for ${meta.name}`);
    err.code = "INVALID_MODE";
    throw err;
  }
  const e = getPolicyEngine();
  e.reload();
  const algorithms = { ...e.store.algorithms };
  const prev = algorithms[algorithmId] || {
    enabledGlobally: Boolean(meta.defaultEnabled),
    options: {},
  };
  algorithms[algorithmId] = {
    ...prev,
    options: { ...(prev.options || {}), mode },
  };
  e.store = { ...e.store, algorithms };
  e.persist();
  notePolicyConfigWritten();
  invalidateMediationCaches();
  return listGlobalPolicies();
};

/**
 * @param {string} algorithmId
 * @param {Record<string, boolean>} categories
 */
export const setPolicyCategories = (algorithmId, categories) => {
  const meta = POLICY_CATALOG.find((p) => p.id === algorithmId);
  if (!meta) {
    const err = new Error(`Unknown policy: ${algorithmId}`);
    err.code = "UNKNOWN_ALGORITHM";
    throw err;
  }
  const allowed = new Set((meta.categories || []).map((c) => c.id));
  const next = { ...defaultCategoryMap(algorithmId) };
  if (categories && typeof categories === "object") {
    for (const [cid, on] of Object.entries(categories)) {
      if (!allowed.has(cid)) continue;
      next[cid] = Boolean(on);
    }
  }
  const e = getPolicyEngine();
  e.reload();
  const algorithms = { ...e.store.algorithms };
  const prev = algorithms[algorithmId] || {
    enabledGlobally: Boolean(meta.defaultEnabled),
    options: {},
  };
  algorithms[algorithmId] = {
    ...prev,
    options: { ...(prev.options || {}), categories: next },
  };
  e.store = { ...e.store, algorithms };
  e.persist();
  notePolicyConfigWritten();
  invalidateMediationCaches();
  return listGlobalPolicies();
};

/**
 * @param {string} algorithmId
 * @param {string[]} values
 */
export const setPolicyKnownValues = (algorithmId, values) => {
  const meta = POLICY_CATALOG.find((p) => p.id === algorithmId);
  if (!meta?.supportsKnownValues) {
    const err = new Error(`Policy does not support known values: ${algorithmId}`);
    err.code = "UNSUPPORTED";
    throw err;
  }
  const cleaned = [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((s) => String(s || "").trim())
        .filter((s) => s.length >= 3),
    ),
  ].slice(0, 200);
  const e = getPolicyEngine();
  e.reload();
  const algorithms = { ...e.store.algorithms };
  const prev = algorithms[algorithmId] || {
    enabledGlobally: Boolean(meta.defaultEnabled),
    options: {},
  };
  algorithms[algorithmId] = {
    ...prev,
    options: { ...(prev.options || {}), knownValues: cleaned },
  };
  e.store = { ...e.store, algorithms };
  e.persist();
  notePolicyConfigWritten();
  invalidateMediationCaches();
  return listGlobalPolicies();
};

export const getPolicyMode = (algorithmId) => getModeForPolicy(algorithmId);

export const isPolicyActiveForAgent = (agentId, policyId) => {
  syncPolicyFromDisk();
  const e = getPolicyEngine();
  return e.effectiveForAgent(agentId).includes(policyId);
};

/**
 * Run content mediation for an agent on FS/net text.
 */
export const mediateContent = async (ctx) => {
  syncPolicyFromDisk();
  const e = getPolicyEngine();
  const modes = {};
  const policyCategories = {};
  const policyKnownValues = {};
  for (const p of POLICY_CATALOG) {
    modes[p.id] = getModeForPolicy(p.id);
    policyCategories[p.id] = getCategoriesForPolicy(p.id);
    if (p.supportsKnownValues) {
      policyKnownValues[p.id] = getKnownValuesForPolicy(p.id);
    }
  }
  let vaultPlainValues = [];
  if (ctx.direction === "egress" && ctx.agentId) {
    try {
      vaultPlainValues = vault.listPlainValues(ctx.agentId);
    } catch {
      vaultPlainValues = [];
    }
  }
  return e.mediate({
    ...ctx,
    meta: {
      ...(ctx.meta || {}),
      policyModes: modes,
      policyCategories,
      policyKnownValues,
      vaultPlainValues,
    },
  });
};

export const policyStatus = () => {
  try {
    const e = getPolicyEngine();
    e.reload();
    return {
      ok: true,
      configPath: AI_POLICY_CONFIG_PATH,
      algorithms: e.listAlgorithms().map((a) => a.id),
      agentCount: e.listAgents().length,
      global: e
        .listGlobal()
        .filter((a) => a.enabledGlobally)
        .map((a) => a.id),
      catalog: listPolicyCatalog(),
    };
  } catch (err) {
    return {
      ok: false,
      configPath: AI_POLICY_CONFIG_PATH,
      error: err?.message || String(err),
    };
  }
};
