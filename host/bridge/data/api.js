import path from "node:path";
import {
  assertReadable,
  assertWritable,
  maxReadBytes,
  maxWriteBytes,
  effectiveRoots,
} from "./policy.js";
import { transformRead, transformWrite, transformList } from "./transform.js";
import { audit } from "./audit.js";
import { acquire, release } from "./limits.js";
import * as store from "./store.js";
import { workspaceRootFor, sharedRoot, oneBridgeRoot } from "./paths.js";

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

export const ensureAgentWorkspace = async (agentId) => {
  const ws = workspaceRootFor(agentId);
  const shared = sharedRoot();
  await store.ensureDir(ws);
  await store.ensureDir(shared);
  await store.ensureDir(oneBridgeRoot());
  return { workspace: ws, shared };
};

export const health = () => ({
  ok: true,
  version: 1,
  root: oneBridgeRoot(),
  ts: new Date().toISOString(),
});

export const list = async (agent, inputPath = ".", { shallow = true } = {}) => {
  return withLimit(agent, "list", async () => {
    try {
      const { real } = assertReadable(agent, inputPath);
      let entries = await store.listDir(real, { shallow: !!shallow });
      entries = await transformList(agent, real, entries);
      auditOk(agent, "list", {
        path: real,
        count: entries.length,
        shallow: !!shallow,
      });
      return { path: real, entries, shallow: !!shallow };
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
      const entries = await store.walkTree(real, {
        maxDepth: Number(maxDepth) || 3,
        exclude,
        maxEntries: Number(maxEntries) || 8000,
      });
      auditOk(agent, "tree", {
        path: real,
        count: entries.length,
        maxDepth: Number(maxDepth) || 3,
      });
      return { path: real, entries, maxDepth: Number(maxDepth) || 3 };
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
 * offset/length for chunked reads.
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
      let len = length;
      if (len == null || len === "") {
        const info = await store.statPath(real);
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
      let buf = await store.readChunk(real, offset, len);
      buf = await transformRead(agent, real, buf);
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), "utf8");
      auditOk(agent, "read", { path: real, offset, bytes: buf.length });
      if (encoding === "buffer") return { path: real, data: buf, bytes: buf.length };
      if (encoding === "base64") {
        return { path: real, encoding: "base64", content: buf.toString("base64"), bytes: buf.length };
      }
      return { path: real, encoding: "utf8", content: buf.toString("utf8"), bytes: buf.length };
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
      auditOk(agent, "truncate", { path: real, size });
      return { path: real, size: Number(size) || 0 };
    } catch (err) {
      auditFail(agent, "truncate", err, { path: inputPath });
      throw err;
    }
  });
};

export const getRoots = (agent) => effectiveRoots(agent);

export const assertCwdAllowed = (agent, cwd) => {
  const { real } = assertReadable(agent, cwd || effectiveRoots(agent).workspace);
  return real;
};
