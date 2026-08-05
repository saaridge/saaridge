import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { AGENT_FS_EXCLUDES } from "./agent-fs-excludes.js";

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

export const listDir = async (absPath, { shallow = true, withStats = false } = {}) => {
  // Shallow (default): one readdir(withFileTypes) — names + types only.
  // withStats: also lstat each immediate child (parallel) for size/mtime — still
  // one directory, no recursion. Used so FUSE placeholders report real sizes.
  const dirents = await fsp.readdir(absPath, { withFileTypes: true });
  if (!withStats && shallow) {
    return dirents.map((d) => {
      const full = path.join(absPath, d.name);
      const isSymbolicLink = d.isSymbolicLink();
      const isDirectory = d.isDirectory();
      const isFile = d.isFile() || (!isDirectory && !isSymbolicLink);
      return {
        name: d.name,
        path: full,
        isFile,
        isDirectory,
        isSymbolicLink,
        size: 0,
        mtimeMs: 0,
        shallow: true,
      };
    });
  }
  const out = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(absPath, d.name);
      try {
        const st = await fsp.lstat(full);
        return {
          name: d.name,
          path: full,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      } catch {
        return { name: d.name, path: full, error: true };
      }
    }),
  );
  return out;
};

/**
 * Breadth-first tree (no file bodies). Includes size/mtime so FUSE placeholders
 * report real sizes (editors need this to open files). Progressive clients use
 * small maxDepth (e.g. 3) and expand as the user drills down.
 */
export const walkTree = async (
  absPath,
  {
    maxDepth = 3,
    exclude = AGENT_FS_EXCLUDES,
    maxEntries = 8000,
    /** @type {((fullPath: string) => boolean) | null | undefined} */
    skipPath = null,
  } = {},
) => {
  const excludeSet = new Set(exclude || AGENT_FS_EXCLUDES);
  const shouldSkip =
    typeof skipPath === "function" ? skipPath : () => false;
  const out = [];
  const walk = async (dir, depth, relBase) => {
    if (out.length >= maxEntries) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (excludeSet.has(d.name)) continue;
      if (d.name === ".DS_Store" || d.name.startsWith(".saaridge-")) continue;
      const full = path.join(dir, d.name);
      // Never emit or descend into bridge STATE_DIR (path-based).
      if (shouldSkip(full)) continue;
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      let isDirectory = d.isDirectory();
      let isFile = d.isFile() || (!isDirectory && !d.isSymbolicLink());
      let isSymbolicLink = d.isSymbolicLink();
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fsp.lstat(full);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
        isSymbolicLink = st.isSymbolicLink();
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        /* keep dirent defaults */
      }
      out.push({
        rel,
        name: d.name,
        isDirectory,
        isFile,
        isSymbolicLink,
        size,
        mtimeMs,
      });
      if (out.length >= maxEntries) return;
      if (isDirectory && depth < maxDepth) {
        await walk(full, depth + 1, rel);
      }
    }
  };
  await walk(absPath, 1, "");
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
