import path from "node:path";

const matchGlob = (relPath, glob) => {
  const g = String(glob || "");
  if (!g) return false;
  // Simple globs: **/*.ext, *.ext, exact name, prefix**/
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
      "^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
    );
    return re.test(relPath) || re.test(path.basename(relPath));
  }
  return path.basename(relPath) === g || relPath === g;
};

/**
 * Apply read transforms (redact patterns). Operates on Buffer or string.
 */
export const transformRead = (agent, filePath, data) => {
  const patterns = agent?.policy?.transforms?.readRedact;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return data;
  }
  let text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  for (const p of patterns) {
    try {
      const re = new RegExp(String(p), "gi");
      text = text.replace(re, "[REDACTED]");
    } catch {
      /* skip bad regex */
    }
  }
  return Buffer.isBuffer(data) ? Buffer.from(text, "utf8") : text;
};

/**
 * Apply write transforms / blocks. Throws if blocked.
 */
export const transformWrite = (agent, filePath, data) => {
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
  return data;
};
