import os from "node:os";
import path from "node:path";
import {
  oneBridgeRoot,
  sharedRoot,
  workspaceRootFor,
  resolveHostPath,
  resolveUnderRoots,
} from "./paths.js";
import { PRIVATE_STATE_DIR, STATE_DIR } from "../../lib/paths.js";
import { notifyHostHomeWriteDenied } from "../../lib/host-home-grant.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Deny Data API / FUSE access to bridge-private vault (ciphertext + keys). */
export const assertNotPrivateVaultPath = (inputPath) => {
  let resolved;
  try {
    resolved = path.resolve(resolveHostPath(inputPath));
  } catch {
    return;
  }
  const privateRoot = path.resolve(PRIVATE_STATE_DIR);
  const legacyVault = path.resolve(STATE_DIR, "vault");
  const under = (base) =>
    resolved === base || resolved.startsWith(base + path.sep);
  if (under(privateRoot) || under(legacyVault)) {
    const err = new Error(
      "Bridge private vault is not readable via the data plane",
    );
    err.code = "EACCES";
    throw err;
  }
};

/**
 * Build effective path policy for an agent.
 * Strict default:
 *   RW: ~/OneBridge/workspaces/<id>
 *   RO: ~/OneBridge/shared + host home (~) for browse-only navigation
 * Host-home WRITE requires policy.hostHomeWrite (host-user consent).
 */
export const effectiveRoots = (agent) => {
  const id = agent?.id || "unknown";
  const ws = workspaceRootFor(id);
  const shared = sharedRoot();
  const bridge = oneBridgeRoot();
  const home = path.resolve(os.homedir());
  const hostHomeWrite = Boolean(agent?.policy?.hostHomeWrite);

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

  // RW stays under OneBridge only — unless host user granted home write.
  const underBridge = (p) => {
    const r = path.resolve(p);
    const base = path.resolve(bridge);
    return r === base || r.startsWith(base + path.sep);
  };
  const isHostHomeRoot = (p) => path.resolve(p) === home;
  readWrite = readWrite.filter(
    (p) => underBridge(p) || (hostHomeWrite && isHostHomeRoot(p)),
  );
  readOnly = readOnly.filter((p) => underBridge(p) || isHostHomeRoot(p));

  if (hostHomeWrite) {
    if (!readWrite.some(isHostHomeRoot)) readWrite.push(home);
    // RW supersedes RO for the same root.
    readOnly = readOnly.filter((p) => !isHostHomeRoot(p));
  } else if (!readOnly.some(isHostHomeRoot)) {
    // Always expose host home read-only (/host/home → os.homedir()).
    readOnly.push(home);
  }

  if (readWrite.length === 0) {
    readWrite = [ws];
  }

  return {
    readWrite,
    readOnly,
    bridgeRoot: bridge,
    workspace: ws,
    shared,
    hostHome: home,
    hostHomeWrite,
  };
};

export const assertReadable = (agent, inputPath) => {
  assertNotPrivateVaultPath(inputPath);
  const { readWrite, readOnly } = effectiveRoots(agent);
  return resolveUnderRoots(inputPath, [...readWrite, ...readOnly]);
};

export const assertWritable = (agent, inputPath) => {
  assertNotPrivateVaultPath(inputPath);
  const roots = effectiveRoots(agent);
  try {
    return resolveUnderRoots(inputPath, roots.readWrite);
  } catch (err) {
    if (err?.code !== "EACCES") throw err;
    let resolved;
    try {
      resolved = resolveHostPath(inputPath);
    } catch {
      throw err;
    }
    const home = roots.hostHome;
    const underHome =
      resolved === home || String(resolved).startsWith(home + path.sep);
    if (underHome && !roots.hostHomeWrite) {
      try {
        notifyHostHomeWriteDenied(agent, resolved);
      } catch {
        /* best-effort prompt */
      }
      const e = new Error(
        "Host home is read-only until the host user grants write access in OneBridge. Do not use sudo — approve “Allow home write” in the desktop app or control plane.",
      );
      e.code = "EROFS";
      e.needHostHomeWrite = true;
      throw e;
    }
    throw err;
  }
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
  // Host home (~) is browse-only until hostHomeWrite consent.
  pathsReadOnly: ["~/OneBridge/shared", "~"],
  hostHomeWrite: false,
  hostHomeWriteAt: null,
  urls: null,
  maxReadBytes: DEFAULT_MAX_BYTES,
  maxWriteBytes: DEFAULT_MAX_BYTES,
  transforms: {
    readRedact: [],
    writeRedact: [],
    writeBlockGlobs: [".env", "**/*.pem", "**/*.key"],
    // Content rewrite/extract: edit host/bridge/control/lib.js only.
    // Helpers (e.g. extractSecretsToVault) live in control/helpers.js.
    vaultExtract: [],
    net: {
      requestRedact: [],
      responseRedact: [],
    },
  },
});
