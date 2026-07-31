/**
 * In-memory FS memos for mediated host access.
 * - Tree memo: skip walkTree when root gen (mtimeMs, size) matches.
 * - Body memo: serve transformed bytes after cheap gen revalidation.
 * No durable disk cache of host file bodies.
 *
 * Retail RAM budget: metadata ≤64MB + body ≤64MB hard LRU (env-tunable).
 */
import path from "node:path";

const TREE_MAX = Number(process.env.ONEBRIDGE_TREE_MEMO_MAX || 64);
const TREE_MAX_BYTES = Number(
  process.env.ONEBRIDGE_TREE_MEMO_BYTES || 64 * 1024 * 1024,
);
const BODY_MAX_FILE = Number(
  process.env.ONEBRIDGE_BODY_MEMO_MAX_FILE || 2 * 1024 * 1024,
);
const BODY_MAX_TOTAL = Number(
  process.env.ONEBRIDGE_BODY_MEMO_TOTAL || 64 * 1024 * 1024,
);
const EVENTS_MAX = 512;

/** @type {Map<string, { entries: any[], rootMtimeMs: number, rootSize: number, ts: number, maxDepth: number, maxEntries: number, includeExcluded: boolean, bytes: number }>} */
const treeMemo = new Map();
/** @type {Map<string, { buf: Buffer, mtimeMs: number, size: number, ts: number }>} */
const bodyMemo = new Map();
let bodyBytes = 0;
let treeBytes = 0;

/** @type {{ id: number, path: string, op: string, ts: number }[]} */
const events = [];
let eventSeq = 0;

/** Gen key: (mtimeMs, size) — host-fresh check without reading bodies. */
export const fileGen = (mtimeMs, size) =>
  `${Number(mtimeMs) || 0}:${Number(size) || 0}`;

export const genMatches = (aMtime, aSize, bMtime, bSize) =>
  Number(aMtime) === Number(bMtime) && Number(aSize) === Number(bSize);

const treeKey = (realPath, maxDepth, maxEntries, includeExcluded) =>
  `${realPath}\0${maxDepth}\0${maxEntries}\0${includeExcluded ? 1 : 0}`;

const estimateEntriesBytes = (entries) => {
  try {
    return Buffer.byteLength(JSON.stringify(entries || []), "utf8");
  } catch {
    return (entries || []).length * 64;
  }
};

const touchTree = (key, value) => {
  const prev = treeMemo.get(key);
  if (prev) {
    treeBytes -= prev.bytes || 0;
    treeMemo.delete(key);
  }
  treeMemo.set(key, value);
  treeBytes += value.bytes || 0;
  while (
    (treeMemo.size > TREE_MAX || treeBytes > TREE_MAX_BYTES) &&
    treeMemo.size > 0
  ) {
    const oldest = treeMemo.keys().next().value;
    const v = treeMemo.get(oldest);
    treeMemo.delete(oldest);
    if (v) treeBytes -= v.bytes || 0;
  }
};

const touchBody = (realPath, value) => {
  const prev = bodyMemo.get(realPath);
  if (prev) {
    bodyBytes -= prev.buf.length;
    bodyMemo.delete(realPath);
  }
  bodyMemo.set(realPath, value);
  bodyBytes += value.buf.length;
  while (bodyBytes > BODY_MAX_TOTAL && bodyMemo.size > 0) {
    const oldest = bodyMemo.keys().next().value;
    const v = bodyMemo.get(oldest);
    bodyMemo.delete(oldest);
    if (v) bodyBytes -= v.buf.length;
  }
};

/**
 * @returns {any[] | null}
 */
export const getTreeMemo = (
  realPath,
  maxDepth,
  maxEntries,
  includeExcluded,
  rootMtimeMs,
  rootSize = 0,
) => {
  const key = treeKey(realPath, maxDepth, maxEntries, !!includeExcluded);
  const hit = treeMemo.get(key);
  if (!hit) return null;
  if (!genMatches(hit.rootMtimeMs, hit.rootSize, rootMtimeMs, rootSize)) {
    treeBytes -= hit.bytes || 0;
    treeMemo.delete(key);
    return null;
  }
  touchTree(key, hit);
  return hit.entries;
};

export const setTreeMemo = (
  realPath,
  maxDepth,
  maxEntries,
  includeExcluded,
  entries,
  rootMtimeMs,
  rootSize = 0,
) => {
  const key = treeKey(realPath, maxDepth, maxEntries, !!includeExcluded);
  const bytes = estimateEntriesBytes(entries);
  touchTree(key, {
    entries,
    rootMtimeMs: Number(rootMtimeMs) || 0,
    rootSize: Number(rootSize) || 0,
    ts: Date.now(),
    maxDepth,
    maxEntries,
    includeExcluded: !!includeExcluded,
    bytes,
  });
};

/**
 * Return memoized body if gen (mtime+size) matches host stat.
 * @returns {Buffer | null}
 */
export const getBodyMemo = (realPath, mtimeMs, size) => {
  const hit = bodyMemo.get(realPath);
  if (!hit) return null;
  if (!genMatches(hit.mtimeMs, hit.size, mtimeMs, size)) {
    bodyBytes -= hit.buf.length;
    bodyMemo.delete(realPath);
    return null;
  }
  touchBody(realPath, hit);
  return hit.buf;
};

export const setBodyMemo = (realPath, buf, mtimeMs, size) => {
  if (!Buffer.isBuffer(buf)) return;
  if (buf.length > BODY_MAX_FILE) return;
  if (Number(size) > BODY_MAX_FILE) return;
  touchBody(realPath, {
    buf,
    mtimeMs: Number(mtimeMs) || 0,
    size: Number(size) || buf.length,
    ts: Date.now(),
  });
};

export const bodyMemoMaxFile = () => BODY_MAX_FILE;

/** Bust body + tree memos for path and ancestors; publish invalidate event. */
export const bust = (realPath, op = "mutate") => {
  if (!realPath) return;
  const normalized = path.resolve(realPath);
  const bodyHit = bodyMemo.get(normalized);
  if (bodyHit) {
    bodyBytes -= bodyHit.buf.length;
    bodyMemo.delete(normalized);
  }
  if (realPath !== normalized && bodyMemo.has(realPath)) {
    const v = bodyMemo.get(realPath);
    bodyBytes -= v.buf.length;
    bodyMemo.delete(realPath);
  }

  for (const key of [...treeMemo.keys()]) {
    const root = key.split("\0")[0];
    if (
      root === normalized ||
      root === realPath ||
      normalized.startsWith(root + path.sep) ||
      root.startsWith(normalized + path.sep) ||
      realPath.startsWith(root + path.sep) ||
      root.startsWith(realPath + path.sep)
    ) {
      const v = treeMemo.get(key);
      if (v) treeBytes -= v.bytes || 0;
      treeMemo.delete(key);
    }
  }

  let cur = normalized;
  for (;;) {
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    for (const key of [...treeMemo.keys()]) {
      if (key.split("\0")[0] === parent) {
        const v = treeMemo.get(key);
        if (v) treeBytes -= v.bytes || 0;
        treeMemo.delete(key);
      }
    }
    cur = parent;
  }

  pushEvent(normalized, op);
};

export const pushEvent = (realPath, op = "invalidate") => {
  eventSeq += 1;
  events.push({ id: eventSeq, path: realPath, op, ts: Date.now() });
  while (events.length > EVENTS_MAX) events.shift();
};

/** Events with id > since (exclusive). */
export const getEventsSince = (since = 0) => {
  const s = Number(since) || 0;
  return {
    since: s,
    next: eventSeq,
    events: events.filter((e) => e.id > s),
  };
};

export const memoStats = () => ({
  treeEntries: treeMemo.size,
  treeMax: TREE_MAX,
  treeBytes,
  treeMaxBytes: TREE_MAX_BYTES,
  bodyEntries: bodyMemo.size,
  bodyBytes,
  bodyMaxFile: BODY_MAX_FILE,
  bodyMaxTotal: BODY_MAX_TOTAL,
  eventSeq,
});
