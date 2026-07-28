/**
 * Text vs binary helpers for mediation processors.
 */
const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".json",
  ".jsonc",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".csv",
  ".tsv",
  ".log",
  ".svg",
]);

const TEXT_CTYPE = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/graphql",
  "application/yaml",
  "application/x-yaml",
  "+json",
  "+xml",
];

export const isTextPath = (filePath = "") => {
  const base = String(filePath).split("?")[0];
  const i = base.lastIndexOf(".");
  if (i < 0) return false;
  return TEXT_EXT.has(base.slice(i).toLowerCase());
};

export const isTextContentType = (ctype = "") => {
  const c = String(ctype || "").toLowerCase();
  if (!c) return false;
  return TEXT_CTYPE.some((p) => c.includes(p));
};

/** Heuristic: mostly printable UTF-8 and not an obvious binary magic. */
export const looksLikeTextBuffer = (buf) => {
  if (!buf || !buf.length) return true;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return true;
  }
  // Common binary magics
  if (buf[0] === 0xff && buf[1] === 0xd8) return false; // jpeg
  if (buf[0] === 0x89 && buf[1] === 0x50) return false; // png
  if (buf[0] === 0x47 && buf[1] === 0x49) return false; // gif
  if (buf[0] === 0x25 && buf[1] === 0x50) return false; // pdf
  if (buf[0] === 0x50 && buf[1] === 0x4b) return false; // zip
  const sample = buf.slice(0, Math.min(buf.length, 8000));
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 && b !== 9 && b !== 10 && b !== 13) weird++;
  }
  return weird / sample.length < 0.02;
};

export const shouldProcessFsText = (filePath, data) => {
  if (isTextPath(filePath)) return true;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "utf8");
  return looksLikeTextBuffer(buf);
};

export const isCompressedContent = (headers = {}) => {
  const enc = String(
    headers["content-encoding"] || headers["Content-Encoding"] || "",
  ).toLowerCase();
  return /gzip|deflate|br|zstd|compress/.test(enc);
};

/** Bodies that must be streamed byte-for-byte (installers, zips, etc.). */
export const shouldStreamOpaqueBody = (headers = {}, contentLength = 0) => {
  if (isCompressedContent(headers) && contentLength > 256 * 1024) return true;
  const ctype = String(
    headers["content-type"] || headers["Content-Type"] || "",
  ).toLowerCase();
  const disp = String(
    headers["content-disposition"] || headers["Content-Disposition"] || "",
  ).toLowerCase();
  if (/attachment|filename=/i.test(disp)) return true;
  if (
    /octet-stream|application\/(zip|gzip|x-gzip|x-tar|x-xz|x-7z|x-rar|pdf|java-archive|x-debian-package|vnd\.debian\.binary-package|x-apple-diskimage|x-msdos-program|x-msdownload|vnd\.microsoft\.portable-executable|wasm)/i.test(
      ctype,
    )
  ) {
    return true;
  }
  // Media bytes must never be UTF-8-decoded under MITM (thumbnails, streams).
  if (/^(image|video|audio|font)\//i.test(ctype)) return true;
  // Large non-text payloads (e.g. .deb served as application/octet-stream missing)
  if (contentLength > 512 * 1024 && !isTextContentType(ctype)) return true;
  return false;
};

export const shouldProcessNetText = (headers = {}, body) => {
  // Compressed bodies must not be treated as UTF-8 text (corrupts HTML/JS under MITM).
  // Decompress-then-process can be added later; until then, pass through bytes.
  if (isCompressedContent(headers)) return false;

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (isTextContentType(ctype)) {
    // Still refuse if payload looks like gzip magic despite missing header
    if (Buffer.isBuffer(body) && body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
      return false;
    }
    return true;
  }
  if (!body) return false;
  if (typeof body === "string") {
    if (body.startsWith("<") && body.includes(" bytes>")) return false; // traffic-log binary placeholder
    return looksLikeTextBuffer(Buffer.from(body, "utf8"));
  }
  if (Buffer.isBuffer(body)) return looksLikeTextBuffer(body);
  return false;
};
