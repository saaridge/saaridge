import path from "node:path";
import {
  oneBridgeRoot,
  sharedRoot,
  workspaceRootFor,
  resolveHostPath,
  resolveUnderRoots,
} from "./paths.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Build effective path policy for an agent.
 * Strict default: only ~/OneBridge/workspaces/<id> (rw) and ~/OneBridge/shared (ro).
 */
export const effectiveRoots = (agent) => {
  const id = agent?.id || "unknown";
  const ws = workspaceRootFor(id);
  const shared = sharedRoot();
  const bridge = oneBridgeRoot();

  const custom = agent?.policy?.paths;
  let readWrite = [];
  let readOnly = [];

  if (Array.isArray(custom) && custom.length > 0) {
    readWrite = custom.map((p) => resolveHostPath(p));
  } else {
    readWrite = [ws];
  }

  const customRo = agent?.policy?.pathsReadOnly;
  if (Array.isArray(customRo) && customRo.length > 0) {
    readOnly = customRo.map((p) => resolveHostPath(p));
  } else {
    readOnly = [shared];
  }

  // Always keep everything under OneBridge root (mass-product safety).
  const underBridge = (p) => {
    const r = path.resolve(p);
    const base = path.resolve(bridge);
    return r === base || r.startsWith(base + path.sep);
  };
  readWrite = readWrite.filter(underBridge);
  readOnly = readOnly.filter(underBridge);

  if (readWrite.length === 0) {
    readWrite = [ws];
  }

  return { readWrite, readOnly, bridgeRoot: bridge, workspace: ws, shared };
};

export const assertReadable = (agent, inputPath) => {
  const { readWrite, readOnly } = effectiveRoots(agent);
  return resolveUnderRoots(inputPath, [...readWrite, ...readOnly]);
};

export const assertWritable = (agent, inputPath) => {
  const { readWrite } = effectiveRoots(agent);
  return resolveUnderRoots(inputPath, readWrite);
};

export const maxReadBytes = (agent) =>
  Number(agent?.policy?.maxReadBytes) > 0
    ? Number(agent.policy.maxReadBytes)
    : DEFAULT_MAX_BYTES;

export const maxWriteBytes = (agent) =>
  Number(agent?.policy?.maxWriteBytes) > 0
    ? Number(agent.policy.maxWriteBytes)
    : DEFAULT_MAX_BYTES;

/** Default policy object for new agents / desktop. */
export const defaultDataPolicy = (agentId) => ({
  allowAllProxy: true,
  tools: null,
  paths: [`~/OneBridge/workspaces/${agentId}`],
  pathsReadOnly: ["~/OneBridge/shared"],
  urls: null,
  maxReadBytes: DEFAULT_MAX_BYTES,
  maxWriteBytes: DEFAULT_MAX_BYTES,
  transforms: {
    readRedact: [],
    writeBlockGlobs: [".env", "**/*.pem", "**/*.key"],
  },
});
