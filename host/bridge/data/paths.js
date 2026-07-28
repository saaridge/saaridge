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
 * Also maps container FUSE paths (/host/...) so Cursor/MCP can pass the
 * paths they see inside the desktop without policy denying them.
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

  // Normalize duplicate slashes
  p = p.replace(/\/+/g, "/");

  // Container FUSE layout → host paths (mediated).
  if (p === "/host" || p === "/host/") {
    return oneBridgeRoot();
  }
  if (p === "/host/home" || p.startsWith("/host/home/")) {
    const rest = p === "/host/home" ? "" : p.slice("/host/home/".length);
    return rest ? path.join(os.homedir(), rest) : os.homedir();
  }
  if (p === "/host/shared" || p.startsWith("/host/shared/")) {
    const rest = p === "/host/shared" ? "" : p.slice("/host/shared/".length);
    return rest ? path.join(sharedRoot(), rest) : sharedRoot();
  }
  if (p === "/host/workspaces" || p.startsWith("/host/workspaces/")) {
    const rest = p === "/host/workspaces" ? "" : p.slice("/host/workspaces/".length);
    return rest
      ? path.join(oneBridgeRoot(), "workspaces", rest)
      : path.join(oneBridgeRoot(), "workspaces");
  }
  if (p.startsWith("/host/")) {
    return path.join(oneBridgeRoot(), p.slice("/host/".length));
  }

  // Desktop symlink: /home/browser/<Hostname> Home/... → host home
  const m = p.match(/^\/home\/[^/]+\/[^/]+ Home(?:\/(.*))?$/);
  if (m) {
    const rest = m[1] || "";
    return rest ? path.join(os.homedir(), rest) : os.homedir();
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
