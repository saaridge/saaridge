/**
 * Host-only AI policy admin — wraps @ai-policy-engine for the control plane.
 * Config lives under state/private (never FUSE / container mounted).
 */
import path from "node:path";
import {
  AlgorithmRegistry,
  PolicyEngine,
} from "@ai-policy-engine/core";
import { registerStubAlgorithms } from "@ai-policy-engine/algorithms";
import { PRIVATE_STATE_DIR } from "./paths.js";

export const AI_POLICY_CONFIG_PATH =
  process.env.AI_POLICY_CONFIG ||
  path.join(PRIVATE_STATE_DIR, "ai-policies.json");

let engine = null;

export const getPolicyEngine = () => {
  if (engine) return engine;
  const registry = new AlgorithmRegistry();
  registerStubAlgorithms(registry);
  engine = new PolicyEngine({
    registry,
    configPath: AI_POLICY_CONFIG_PATH,
  });
  return engine;
};

/** Reset singleton (tests). */
export const resetPolicyEngine = () => {
  engine = null;
};

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

/**
 * @param {string} agentId
 * @param {string} algorithmId
 * @param {"follow" | "on" | "off"} mode
 */
export const setPolicyOverride = (agentId, algorithmId, mode) => {
  const e = getPolicyEngine();
  e.reload();
  return e.setOverride(agentId, algorithmId, mode);
};

export const listGlobalPolicies = () => {
  const e = getPolicyEngine();
  e.reload();
  return e.listGlobal();
};

/**
 * @param {string} algorithmId
 * @param {boolean} enabled
 */
export const setGlobalPolicy = (algorithmId, enabled) => {
  const e = getPolicyEngine();
  e.reload();
  e.setGlobal(algorithmId, enabled);
  return e.listGlobal();
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
      global: e.listGlobal().filter((a) => a.enabledGlobally).map((a) => a.id),
    };
  } catch (err) {
    return {
      ok: false,
      configPath: AI_POLICY_CONFIG_PATH,
      error: err?.message || String(err),
    };
  }
};
