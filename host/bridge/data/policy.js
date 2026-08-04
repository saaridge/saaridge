import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  oneBridgeRoot,
  sharedRoot,
  workspaceRootFor,
  resolveHostPath,
  resolveUnderRoots,
} from "./paths.js";
import { STATE_DIR } from "../../lib/paths.js";
import { notifyHostHomeWriteDenied } from "../../lib/host-home-grant.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB
const INODE_CACHE_TTL_MS = 60_000;

/** @type {{ until: number, keys: Set<string> } | null} */
let stateInodeCache = null;

const stateRoot = () => path.resolve(STATE_DIR);

const underDir = (candidate, base) => {
  const c = path.resolve(candidate);
  const b = path.resolve(base);
  return c === b || c.startsWith(b + path.sep);
};

const denyBridgeState = () => {
  const err = new Error(
    "Bridge state is not readable via the data plane",
  );
  err.code = "EACCES";
  throw err;
};

const walkInodes = (dir, out) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      // Use lstat so we index symlink nodes too; follow only directories.
      const st = fs.lstatSync(full);
      out.add(`${st.dev}:${st.ino}`);
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        walkInodes(full, out);
      }
    } catch {
      /* skip unreadable */
    }
  }
};

/** Refresh inode set for STATE_DIR (hardlink escape detection). */
export const refreshBridgeStateInodes = () => {
  const keys = new Set();
  const root = stateRoot();
  try {
    if (fs.existsSync(root)) {
      const st = fs.statSync(root);
      keys.add(`${st.dev}:${st.ino}`);
      walkInodes(root, keys);
    }
  } catch {
    /* ignore */
  }
  stateInodeCache = {
    until: Date.now() + INODE_CACHE_TTL_MS,
    keys,
  };
  return keys;
};

const bridgeStateInodes = () => {
  if (!stateInodeCache || Date.now() > stateInodeCache.until) {
    refreshBridgeStateInodes();
  }
  return stateInodeCache.keys;
};

/**
 * True when absPath is this install's bridge STATE_DIR (or under it).
 * Path-based — do not use basename "state" (unrelated project folders).
 */
export const isBridgeStatePath = (absPath) => {
  if (absPath == null || absPath === "") return false;
  try {
    return underDir(path.resolve(String(absPath)), stateRoot());
  } catch {
    return false;
  }
};

/**
 * Drop listing children that resolve under STATE_DIR (e.g. omit `state/`
 * from the repo root list so FUSE never caches vault.key metadata).
 * @param {string} parentReal
 * @param {Array<{ name?: string, path?: string, rel?: string }>} entries
 */
export const filterBridgeStateListing = (parentReal, entries) => {
  if (!Array.isArray(entries) || entries.length === 0) return entries || [];
  const parent = path.resolve(parentReal || ".");
  return entries.filter((e) => {
    const name = e?.name;
    if (!name && !e?.path && !e?.rel) return true;
    let child;
    if (e.path) {
      child = path.resolve(String(e.path));
    } else if (e.rel) {
      // Tree entries: rel is relative to the walk root (parentReal).
      child = path.resolve(parent, String(e.rel));
    } else {
      child = path.resolve(parent, String(name));
    }
    return !isBridgeStatePath(child);
  });
};

/**
 * Deny Data API / FUSE access to all bridge state (tokens, MITM keys,
 * vault, traffic logs). Checks logical path, realpath, and hardlink inodes.
 */
export const assertNotPrivateVaultPath = (inputPath) => {
  let resolved;
  try {
    resolved = path.resolve(resolveHostPath(inputPath));
  } catch {
    return;
  }

  const root = stateRoot();
  if (underDir(resolved, root)) denyBridgeState();

  let real = resolved;
  try {
    if (fs.existsSync(resolved)) {
      real = fs.realpathSync(resolved);
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        real = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    }
  } catch {
    real = resolved;
  }
  if (underDir(real, root)) denyBridgeState();

  // Hardlink: realpath may stay under workspace while inode is in STATE_DIR.
  try {
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      const key = `${st.dev}:${st.ino}`;
      let keys = bridgeStateInodes();
      if (keys.has(key)) denyBridgeState();
      // Multi-link: refresh once so newly created state files are covered.
      else if (st.nlink > 1) {
        keys = refreshBridgeStateInodes();
        if (keys.has(key)) denyBridgeState();
      }
    }
  } catch (err) {
    if (err?.code === "EACCES") throw err;
    /* ignore other stat errors */
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
