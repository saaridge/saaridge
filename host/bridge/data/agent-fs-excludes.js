/**
 * Exact-basename dirs omitted from the agent-oriented host view (FUSE / list / tree).
 * Host package managers still see these on disk; coding agents do not need to browse them.
 * Match is exact name only — not glob patterns.
 *
 * Explicit-path exception: if the request path itself contains an excluded segment
 * (e.g. list/read …/node_modules/…), that path is allowed shallowly. Parent listings
 * still omit excluded basenames. See pathHasExcludedComponent / isExplicitExcludedAccess.
 */
import path from "node:path";

export const AGENT_FS_EXCLUDES = Object.freeze([
  // JS / TS
  "node_modules",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".parcel-cache",
  ".eslintcache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".output",
  ".svelte-kit",
  "dist",
  "build",
  "coverage",
  // Python
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".eggs",
  ".ipynb_checkpoints",
  "htmlcov",
  ".hypothesis",
  // Go / PHP / Ruby
  "vendor",
  ".bundle",
  // Rust / JVM / Scala
  "target",
  ".gradle",
  ".idea",
  "out",
  ".bloop",
  ".metals",
  // Apple / Swift
  "Pods",
  "DerivedData",
  "xcuserdata",
  ".swiftpm",
  // .NET
  "bin",
  "obj",
  "packages",
  ".vs",
  // Dart / Flutter
  ".dart_tool",
  // Elixir
  "_build",
  ".elixir_ls",
  "deps",
  // Haskell
  ".stack-work",
  "dist-newstyle",
  // Cross-cutting
  ".git",
  ".cache",
  "Library",
]);

const EXCLUDE_SET = new Set(AGENT_FS_EXCLUDES);

/** @param {string | undefined | null} name */
export const isExcludedBasename = (name) =>
  Boolean(name) && EXCLUDE_SET.has(String(name));

export const filterExcludedEntries = (entries) =>
  (entries || []).filter((e) => !isExcludedBasename(e?.name));

/**
 * True if any path segment is an excluded basename.
 * Accepts absolute host paths or virtual fuse-style paths.
 * @param {string | undefined | null} absOrVirtPath
 */
export const pathHasExcludedComponent = (absOrVirtPath) => {
  if (!absOrVirtPath) return false;
  const normalized = String(absOrVirtPath).replace(/\\/g, "/");
  for (const part of normalized.split("/")) {
    if (part && EXCLUDE_SET.has(part)) return true;
  }
  return false;
};

/**
 * True when the caller asked for a location under an ignore-list name
 * (path is the signal — no special agent flag).
 * @param {string | undefined | null} requestPath
 */
export const isExplicitExcludedAccess = (requestPath) =>
  pathHasExcludedComponent(requestPath);

/** Basename of the deepest excluded segment, or null. */
export const deepestExcludedBasename = (absOrVirtPath) => {
  if (!absOrVirtPath) return null;
  const parts = String(absOrVirtPath).replace(/\\/g, "/").split("/").filter(Boolean);
  let last = null;
  for (const part of parts) {
    if (EXCLUDE_SET.has(part)) last = part;
  }
  return last;
};

/**
 * Split path into segments (posix-ish).
 * @param {string} p
 */
export const pathSegments = (p) =>
  path.normalize(String(p || "")).replace(/\\/g, "/").split("/").filter(Boolean);
