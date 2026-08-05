import {
  assertReadable,
  assertWritable,
  maxReadBytes,
  maxWriteBytes,
  effectiveRoots,
  isBridgeStatePath,
  filterBridgeStateListing,
} from "./policy.js";
import { transformRead, transformWrite, transformList } from "./transform.js";
import { audit } from "./audit.js";
import { acquire, release } from "./limits.js";
import * as store from "./store.js";
import { workspaceRootFor, sharedRoot, saaridgeRoot } from "./paths.js";
import {
  AGENT_FS_EXCLUDES,
  filterExcludedEntries,
  pathHasExcludedComponent,
  isExplicitExcludedAccess,
} from "./agent-fs-excludes.js";
import * as fsMemo from "./fs-memo.js";

/** Match FUSE default tree hydrate depth. */
const WARM_TREE_DEPTH = Number(process.env.HOSTFS_TREE_DEPTH || 4) || 4;
const WARM_TREE_MAX = Number(process.env.HOSTFS_TREE_MAX || 8000) || 8000;

const withLimit = async (agent, op, fn) => {
  const id = agent?.id;
  await acquire(id);
  try {
    return await fn();
  } finally {
    release(id);
  }
};

const auditOk = (agent, op, detail) => {
  audit({
    plane: "data",
    op,
    agentId: agent?.id,
    ok: true,
    ...detail,
  });
};

const auditFail = (agent, op, err, detail) => {
  audit({
    plane: "data",
    op,
    agentId: agent?.id,
    ok: false,
    error: err?.message || String(err),
    code: err?.code,
    ...detail,
  });
};

const warmTreeAsync = (realPath) => {
  // Never deep-warm ignore-list trees (explicit access is shallow only).
  if (pathHasExcludedComponent(realPath)) return;
  // Never warm under bridge STATE_DIR.
  if (isBridgeStatePath(realPath)) return;
  // Fire-and-forget: populate tree memo so IDE FUSE hydrate is instant.
  setImmediate(() => {
    (async () => {
      try {
        const info = await store.statPath(realPath);
        if (!info.isDirectory) return;
        const maxDepth = WARM_TREE_DEPTH;
        const maxEntries = WARM_TREE_MAX;
        const includeExcluded = false;
        const existing = fsMemo.getTreeMemo(
          realPath,
          maxDepth,
          maxEntries,
          includeExcluded,
          info.mtimeMs,
          info.size,
        );
        if (existing) return;
        const entries = await store.walkTree(realPath, {
          maxDepth,
          exclude: AGENT_FS_EXCLUDES,
          maxEntries,
          skipPath: isBridgeStatePath,
        });
        fsMemo.setTreeMemo(
          realPath,
          maxDepth,
          maxEntries,
          includeExcluded,
          entries,
          info.mtimeMs,
          info.size,
        );
      } catch {
        /* warm is best-effort */
      }
    })();
  });
};

export const ensureAgentWorkspace = async (agentId) => {
  const ws = workspaceRootFor(agentId);
  const shared = sharedRoot();
  await store.ensureDir(ws);
  await store.ensureDir(shared);
  await store.ensureDir(saaridgeRoot());
  return { workspace: ws, shared };
};

export const health = () => ({
  ok: true,
  version: 1,
  root: saaridgeRoot(),
  excludes: [...AGENT_FS_EXCLUDES],
  memo: fsMemo.memoStats(),
  ts: new Date().toISOString(),
});

export const list = async (
  agent,
  inputPath = ".",
  { shallow = true, withStats = false, includeExcluded = false } = {},
) => {
  return withLimit(agent, "list", async () => {
    try {
      const { real } = assertReadable(agent, inputPath);
      // Path is the signal: explicit open of an ignore-list dir auto-includes
      // that directory; nested exclude basenames are still filtered.
      const explicitExcluded = isExplicitExcludedAccess(real);
      const includeFlag = Boolean(includeExcluded) || explicitExcluded;
      let entries = await store.listDir(real, {
        shallow: !!shallow,
        withStats: !!withStats,
      });
      entries = await transformList(agent, real, entries);
      // Product filter after control-lib transform — not redaction.
      // Explicit excluded access still omits nested ignore-list basenames.
      if (explicitExcluded || !includeFlag) {
        entries = filterExcludedEntries(entries);
      }
      // CONSTRAINTS §3: never list this install's STATE_DIR (vault/tokens/MITM).
      entries = filterBridgeStateListing(real, entries);
      // Agent/IDE browse warms tree memo for FUSE folder open (non-excluded only).
      warmTreeAsync(real);
      auditOk(agent, "list", {
        path: real,
        count: entries.length,
        shallow: !!shallow,
        withStats: !!withStats,
        includeExcluded: includeFlag,
        explicitExcluded,
      });
      return {
        path: real,
        entries,
        shallow: !!shallow,
        withStats: !!withStats,
        includeExcluded: includeFlag,
        explicitExcluded,
      };
    } catch (err) {
      auditFail(agent, "list", err, { path: inputPath });
      throw err;
    }
  });
};

/** One-shot mediated tree (names/types). No file bodies. */
export const tree = async (
  agent,
  inputPath = ".",
  { maxDepth = 3, exclude, maxEntries = 8000 } = {},
) => {
  return withLimit(agent, "tree", async () => {
    try {
      const { real } = assertReadable(agent, inputPath);
      const underExcluded = pathHasExcludedComponent(real);
      // Explicit ignore-list root: shallow only — never deep-hydrate registries.
      let depth = Number(maxDepth) || 3;
      if (underExcluded) depth = Math.min(depth, 1);
      const cap = Number(maxEntries) || 8000;
      const includeExcluded = underExcluded;
      const info = await store.statPath(real);
      const memoHit = fsMemo.getTreeMemo(
        real,
        depth,
        cap,
        includeExcluded,
        info.mtimeMs,
        info.size,
      );
      let entries;
      let fromMemo = false;
      if (memoHit) {
        entries = memoHit;
        fromMemo = true;
      } else {
        entries = await store.walkTree(real, {
          maxDepth: depth,
          exclude: exclude || AGENT_FS_EXCLUDES,
          maxEntries: cap,
          skipPath: isBridgeStatePath,
        });
        fsMemo.setTreeMemo(
          real,
          depth,
          cap,
          includeExcluded,
          entries,
          info.mtimeMs,
          info.size,
        );
      }
      // Defense in depth: drop any STATE_DIR entries (incl. stale memo).
      entries = filterBridgeStateListing(real, entries);
      auditOk(agent, "tree", {
        path: real,
        count: entries.length,
        maxDepth: depth,
        memo: fromMemo,
        explicitExcluded: underExcluded,
      });
      return {
        path: real,
        entries,
        maxDepth: depth,
        memo: fromMemo,
        explicitExcluded: underExcluded,
      };
    } catch (err) {
      auditFail(agent, "tree", err, { path: inputPath });
      throw err;
    }
  });
};

export const stat = async (agent, inputPath) => {
  return withLimit(agent, "stat", async () => {
    try {
      const { real } = assertReadable(agent, inputPath);
      const info = await store.statPath(real);
      auditOk(agent, "stat", { path: real });
      return info;
    } catch (err) {
      auditFail(agent, "stat", err, { path: inputPath });
      throw err;
    }
  });
};

/**
 * Read file or chunk. For MCP convenience, encoding utf8|base64|buffer.
 * offset/length for chunked reads. Body memo revalidated via host stat.
 */
export const read = async (
  agent,
  inputPath,
  { offset = 0, length = undefined, encoding = "utf8" } = {},
) => {
  return withLimit(agent, "read", async () => {
    try {
      const { real } = assertReadable(agent, inputPath);
      const max = maxReadBytes(agent);
      const info = await store.statPath(real);
      let len = length;
      if (len == null || len === "") {
        if (info.size > max) {
          const err = new Error(
            `File too large (${info.size} > ${max}); use offset/length chunked reads`,
          );
          err.code = "EFBIG";
          throw err;
        }
        len = info.size;
      } else if (Number(len) > max) {
        const err = new Error(`Read length exceeds maxReadBytes (${max})`);
        err.code = "EFBIG";
        throw err;
      }
      const off = Number(offset) || 0;
      const want = Number(len);
      let buf;
      let fromMemo = false;
      const memoBuf = fsMemo.getBodyMemo(real, info.mtimeMs, info.size);
      if (memoBuf) {
        buf = memoBuf.subarray(off, off + want);
        fromMemo = true;
      } else {
        // Full-file read under memo cap → transform once and store.
        const canMemo =
          info.size <= fsMemo.bodyMemoMaxFile() &&
          off === 0 &&
          want >= info.size;
        if (canMemo) {
          let full = await store.readChunk(real, 0, info.size);
          full = await transformRead(agent, real, full);
          if (!Buffer.isBuffer(full)) full = Buffer.from(String(full), "utf8");
          fsMemo.setBodyMemo(real, full, info.mtimeMs, info.size);
          // Whole-file reads must return the full mediated body (rewrite may
          // change length). Chunked reads still slice by host offset/want.
          buf =
            off === 0 && want >= info.size
              ? full
              : full.subarray(off, off + want);
        } else {
          buf = await store.readChunk(real, off, want);
          buf = await transformRead(agent, real, buf);
          if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), "utf8");
          // If we fetched the whole file in one go under cap, memoize.
          if (
            off === 0 &&
            want >= info.size &&
            info.size <= fsMemo.bodyMemoMaxFile()
          ) {
            fsMemo.setBodyMemo(real, buf, info.mtimeMs, info.size);
          }
        }
      }
      // Memo hit: whole-file clients get the full mediated buffer.
      if (fromMemo && off === 0 && want >= info.size) {
        buf = memoBuf;
      }
      auditOk(agent, "read", {
        path: real,
        offset: off,
        bytes: buf.length,
        memo: fromMemo,
      });
      if (encoding === "buffer") return { path: real, data: buf, bytes: buf.length, memo: fromMemo };
      if (encoding === "base64") {
        return {
          path: real,
          encoding: "base64",
          content: buf.toString("base64"),
          bytes: buf.length,
          memo: fromMemo,
        };
      }
      return {
        path: real,
        encoding: "utf8",
        content: buf.toString("utf8"),
        bytes: buf.length,
        memo: fromMemo,
      };
    } catch (err) {
      auditFail(agent, "read", err, { path: inputPath });
      throw err;
    }
  });
};

export const write = async (
  agent,
  inputPath,
  content,
  { offset = 0, truncate = true, encoding = "utf8" } = {},
) => {
  return withLimit(agent, "write", async () => {
    try {
      const { real } = assertWritable(agent, inputPath);
      let data =
        Buffer.isBuffer(content)
          ? content
          : encoding === "base64"
            ? Buffer.from(String(content), "base64")
            : Buffer.from(String(content ?? ""), "utf8");
      data = await transformWrite(agent, real, data);
      if (!Buffer.isBuffer(data)) data = Buffer.from(data);
      const max = maxWriteBytes(agent);
      if (data.length > max) {
        const err = new Error(`Write exceeds maxWriteBytes (${max})`);
        err.code = "EFBIG";
        throw err;
      }
      const result = await store.writeChunk(real, data, {
        offset: Number(offset) || 0,
        truncate: Boolean(truncate) && (Number(offset) || 0) === 0,
      });
      fsMemo.bust(real, "write");
      auditOk(agent, "write", { path: real, bytes: result.bytesWritten, offset });
      return result;
    } catch (err) {
      auditFail(agent, "write", err, { path: inputPath });
      throw err;
    }
  });
};

export const mkdir = async (agent, inputPath) => {
  return withLimit(agent, "mkdir", async () => {
    try {
      const { real } = assertWritable(agent, inputPath);
      const result = await store.mkdirPath(real);
      fsMemo.bust(real, "mkdir");
      auditOk(agent, "mkdir", { path: real });
      return result;
    } catch (err) {
      auditFail(agent, "mkdir", err, { path: inputPath });
      throw err;
    }
  });
};

export const unlink = async (agent, inputPath) => {
  return withLimit(agent, "unlink", async () => {
    try {
      const { real } = assertWritable(agent, inputPath);
      const result = await store.unlinkPath(real);
      fsMemo.bust(real, "unlink");
      auditOk(agent, "unlink", { path: real });
      return result;
    } catch (err) {
      auditFail(agent, "unlink", err, { path: inputPath });
      throw err;
    }
  });
};

export const rename = async (agent, fromPath, toPath) => {
  return withLimit(agent, "rename", async () => {
    try {
      const from = assertWritable(agent, fromPath);
      const to = assertWritable(agent, toPath);
      const result = await store.renamePath(from.real, to.real);
      fsMemo.bust(from.real, "rename");
      fsMemo.bust(to.real, "rename");
      auditOk(agent, "rename", { from: from.real, to: to.real });
      return result;
    } catch (err) {
      auditFail(agent, "rename", err, { from: fromPath, to: toPath });
      throw err;
    }
  });
};

export const truncate = async (agent, inputPath, size = 0) => {
  return withLimit(agent, "truncate", async () => {
    try {
      const { real } = assertWritable(agent, inputPath);
      await store.truncatePath(real, size);
      fsMemo.bust(real, "truncate");
      auditOk(agent, "truncate", { path: real, size });
      return { path: real, size: Number(size) || 0 };
    } catch (err) {
      auditFail(agent, "truncate", err, { path: inputPath });
      throw err;
    }
  });
};

export const getFsEvents = (since = 0) => fsMemo.getEventsSince(since);

export const getRoots = (agent) => effectiveRoots(agent);

export const assertCwdAllowed = (agent, cwd) => {
  const { real } = assertReadable(agent, cwd || effectiveRoots(agent).workspace);
  return real;
};
