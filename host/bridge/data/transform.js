/**
 * Data-plane transforms — thin wrapper over control pipeline.
 * Content decisions live in host/bridge/control/lib.js only.
 */
import path from "node:path";
import * as control from "../control/index.js";

const matchGlob = (relPath, glob) => {
  const g = String(glob || "");
  if (!g) return false;
  if (g.startsWith("**/")) {
    const suf = g.slice(3);
    if (suf.startsWith("*.")) {
      const ext = suf.slice(1);
      return relPath.endsWith(ext) || path.basename(relPath).endsWith(ext);
    }
    return relPath.endsWith(suf) || path.basename(relPath) === suf;
  }
  if (g.startsWith("*.")) {
    return path.basename(relPath).endsWith(g.slice(1));
  }
  if (g.includes("*")) {
    const re = new RegExp(
      "^" +
        g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") +
        "$",
    );
    return re.test(relPath) || re.test(path.basename(relPath));
  }
  return path.basename(relPath) === g || relPath === g;
};

/** Apply read virtualization via control library. */
export const transformRead = async (agent, filePath, data) => {
  const result = await control.onFsRead({ agent, path: filePath, data });
  if (result?.action === "deny") {
    const err = new Error(result.reason || "Read denied by virtual view");
    err.code = "EACCES";
    throw err;
  }
  if (result?.action === "rewrite") {
    return result.data;
  }
  return result?.data ?? data;
};

/** Apply write transforms / glob blocks. Throws if blocked. */
export const transformWrite = async (agent, filePath, data) => {
  const blocks = agent?.policy?.transforms?.writeBlockGlobs;
  if (Array.isArray(blocks) && blocks.length > 0) {
    const base = path.basename(filePath);
    const rel = filePath;
    for (const g of blocks) {
      if (matchGlob(base, g) || matchGlob(rel, g)) {
        const err = new Error(`Write blocked by policy (matches ${g}): ${base}`);
        err.code = "EACCES";
        throw err;
      }
    }
  }
  const result = await control.onFsWrite({ agent, path: filePath, data });
  if (result?.action === "deny") {
    const err = new Error(result.reason || "Write denied by processor");
    err.code = "EACCES";
    throw err;
  }
  if (result?.action === "rewrite") {
    return result.data;
  }
  return result?.data ?? data;
};

/** Virtual directory listing via control library. */
export const transformList = async (agent, dirPath, entries) => {
  const result = await control.onFsList({
    agent,
    path: dirPath,
    entries,
  });
  if (result?.action === "deny") {
    const err = new Error(result.reason || "List denied by virtual view");
    err.code = "EACCES";
    throw err;
  }
  if (result?.action === "rewrite") {
    return result.entries ?? entries;
  }
  return result?.entries ?? entries;
};
