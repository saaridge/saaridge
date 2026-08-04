import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildHostIdentity } from "../../lib/host-identity.js";

/** Host root for all mediated project data. */
export const oneBridgeRoot = () => path.join(os.homedir(), "OneBridge");

export const sharedRoot = () => path.join(oneBridgeRoot(), "shared");

export const workspaceRootFor = (agentId) =>
  path.join(oneBridgeRoot(), "workspaces", String(agentId || "unknown"));

/** Remove an agent's host workspace tree (tests / uninstall cleanup). */
export const removeAgentWorkspace = (agentId) => {
  const ws = workspaceRootFor(agentId);
  const root = path.resolve(oneBridgeRoot());
  const resolved = path.resolve(ws);
  if (!resolved.startsWith(root + path.sep) || resolved === root) {
    throw new Error(`refusing to remove non-workspace path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return resolved;
};

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

/**
 * Map a host absolute path to the container FUSE view (/host/...).
 * Shells inside the container only see these paths — not /Users/... .
 */
export const toContainerPath = (hostAbsPath, agentId = null) => {
  if (hostAbsPath == null || hostAbsPath === "") return "/host";
  let p = path.resolve(String(hostAbsPath));
  const home = path.resolve(os.homedir());
  const bridge = path.resolve(oneBridgeRoot());
  const shared = path.resolve(sharedRoot());
  const wsRoot = path.resolve(path.join(bridge, "workspaces"));

  if (p === bridge || p.startsWith(bridge + path.sep)) {
    const rest = p === bridge ? "" : p.slice(bridge.length + 1).replace(/\\/g, "/");
    return rest ? `/host/${rest}` : "/host";
  }
  if (p === shared || p.startsWith(shared + path.sep)) {
    const rest = p === shared ? "" : p.slice(shared.length + 1).replace(/\\/g, "/");
    return rest ? `/host/shared/${rest}` : "/host/shared";
  }
  if (p === wsRoot || p.startsWith(wsRoot + path.sep)) {
    const rest = p === wsRoot ? "" : p.slice(wsRoot.length + 1).replace(/\\/g, "/");
    return rest ? `/host/workspaces/${rest}` : "/host/workspaces";
  }
  if (p === home || p.startsWith(home + path.sep)) {
    const rest = p === home ? "" : p.slice(home.length + 1).replace(/\\/g, "/");
    return rest ? `/host/home/${rest}` : "/host/home";
  }
  // Already container-shaped
  if (p === "/host" || p.startsWith("/host/")) return p.replace(/\\/g, "/");
  // Fallback: keep agent workspace hint when unknown
  if (agentId) return `/host/workspaces/${agentId}`;
  return "/host";
};

/**
 * Orientation payload for host_info / whoami — dual path layout so agents
 * do not cd/ls host-native paths inside the container shell.
 */
export const hostOrientation = (agent) => {
  const id = String(agent?.id || "unknown");
  const identity = buildHostIdentity(id);
  const home = identity.homedir;
  const bridge = oneBridgeRoot();
  const workspace = workspaceRootFor(id);
  const shared = sharedRoot();
  return {
    virtualizedOnHost: true,
    hostname: identity.hostname,
    platform: identity.platform,
    osType: identity.osType,
    prettyName: identity.prettyName,
    arch: identity.arch,
    release: identity.release,
    /** Native host home for file tools */
    homedir: home,
    /** Shell $HOME */
    home: identity.shell.home,
    shell: {
      ...identity.shell,
      terminal_exec: "disabled",
      note: identity.note,
    },
    mcpFileTools: {
      workspace,
      shared,
      hostHome: home,
      oneBridge: bridge,
      note: "read_file/write_file/list_dir accept host paths OR /host/... ",
    },
    paths: {
      workspace,
      shared,
      home: identity.shell.home,
      workspaceShell: identity.shell.workspace,
      sharedShell: identity.shell.shared,
    },
    note: identity.note,
  };
};
