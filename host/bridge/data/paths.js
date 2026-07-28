import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Host root for all mediated project data. */
export const oneBridgeRoot = () => path.join(os.homedir(), "OneBridge");

export const sharedRoot = () => path.join(oneBridgeRoot(), "shared");

export const workspaceRootFor = (agentId) =>
  path.join(oneBridgeRoot(), "workspaces", String(agentId || "unknown"));

/**
 * Expand ~ and relative paths against the HOST home.
 * Rejects null bytes; resolves to absolute path.
 */
export const resolveHostPath = (input) => {
  if (input == null || input === "") {
    return oneBridgeRoot();
  }
  let p = String(input);
  if (p.includes("\0")) {
    throw new Error("Invalid path");
  }
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) return path.resolve(os.homedir(), p);
  return path.resolve(p);
};

/**
 * Resolve symlinks (if target exists) and ensure final path stays under one of
 * the allowed roots. Returns { resolved, real }.
 */
export const resolveUnderRoots = (input, allowedRoots) => {
  const resolved = path.resolve(resolveHostPath(input));
  let real = resolved;
  try {
    if (fs.existsSync(resolved)) {
      real = fs.realpathSync(resolved);
    } else {
      // For create: ensure parent realpath is under a root, then join basename
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        real = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    }
  } catch {
    real = resolved;
  }

  const roots = (allowedRoots || []).map((r) => path.resolve(resolveHostPath(r)));
  const ok = roots.some((base) => real === base || real.startsWith(base + path.sep));
  if (!ok) {
    const err = new Error(`Path denied by policy: ${resolved}`);
    err.code = "EACCES";
    throw err;
  }
  return { resolved, real };
};
