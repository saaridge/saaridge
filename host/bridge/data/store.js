import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

export const ensureDir = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

export const statPath = async (absPath) => {
  const st = await fsp.stat(absPath);
  return {
    path: absPath,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink?.() || false,
    size: st.size,
    mtimeMs: st.mtimeMs,
    mode: st.mode,
  };
};

export const listDir = async (absPath) => {
  const names = await fsp.readdir(absPath);
  const out = [];
  for (const name of names) {
    const full = path.join(absPath, name);
    try {
      const st = await fsp.lstat(full);
      out.push({
        name,
        path: full,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      out.push({ name, path: full, error: true });
    }
  }
  return out;
};

/**
 * Read a byte range. Returns Buffer. Does not load whole file unless length covers it.
 */
export const readChunk = async (absPath, offset = 0, length = undefined) => {
  const st = await fsp.stat(absPath);
  if (!st.isFile()) {
    const err = new Error("Not a file");
    err.code = "EISDIR";
    throw err;
  }
  const start = Math.max(0, Number(offset) || 0);
  const end =
    length == null || length === ""
      ? st.size
      : Math.min(st.size, start + Math.max(0, Number(length)));
  if (start >= st.size) return Buffer.alloc(0);
  const size = end - start;
  const fh = await fsp.open(absPath, "r");
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

/**
 * Write bytes at offset. Creates parent dirs. fsync on close.
 * If truncateFirst and offset===0, truncates file.
 */
export const writeChunk = async (
  absPath,
  data,
  { offset = 0, truncate = false, create = true } = {},
) => {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const exists = fs.existsSync(absPath);
  if (!exists && !create) {
    const err = new Error("File not found");
    err.code = "ENOENT";
    throw err;
  }
  const off = Number(offset) || 0;
  let flags = "r+";
  if (!exists || (truncate && off === 0)) flags = "w";
  const fh = await fsp.open(absPath, flags);
  try {
    if (truncate && off === 0 && exists && flags === "r+") {
      await fh.truncate(0);
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fh.write(buf, 0, buf.length, off);
    await fh.sync();
    return { bytesWritten: buf.length, path: absPath };
  } finally {
    await fh.close();
  }
};

export const truncatePath = async (absPath, size = 0) => {
  await fsp.truncate(absPath, Number(size) || 0);
};

export const mkdirPath = async (absPath) => {
  await fsp.mkdir(absPath, { recursive: true });
  return { path: absPath, created: true };
};

export const unlinkPath = async (absPath) => {
  const st = await fsp.lstat(absPath);
  if (st.isDirectory()) {
    await fsp.rmdir(absPath);
  } else {
    await fsp.unlink(absPath);
  }
  return { path: absPath, removed: true };
};

export const renamePath = async (fromAbs, toAbs) => {
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return { from: fromAbs, to: toAbs };
};

/** Stream read for large files (returns Node Readable). */
export const createReadStream = (absPath, { start, end } = {}) =>
  fs.createReadStream(absPath, { start, end });

export const createWriteStream = (absPath, { flags = "w" } = {}) => {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  return fs.createWriteStream(absPath, { flags });
};

export { pipeline, Readable, Writable };
