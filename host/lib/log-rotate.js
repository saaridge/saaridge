import fs from "node:fs";

/**
 * Size-capped append + bounded tail read for the host logs.
 *
 * Both logs are written from hot paths (every FS IPC op, every inspected
 * message), so the current size is tracked in memory rather than paying a
 * statSync per line. Without a cap these grew unbounded — traffic.jsonl
 * reached 167MB and bridge.log 24MB — and the readers below used to slurp the
 * whole file to show the last 200 rows.
 */
const sizes = new Map();

const rotate = (file, keep) => {
  try {
    // rename() overwrites, so the oldest generation falls off on its own.
    for (let i = keep - 1; i >= 1; i -= 1) {
      if (fs.existsSync(`${file}.${i}`)) {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
    }
    if (keep >= 1) fs.renameSync(file, `${file}.1`);
    else fs.rmSync(file, { force: true });
  } catch {
    /* never let rotation failure stop logging */
  }
};

export const appendRotating = (file, line, { maxBytes = 0, keep = 2 } = {}) => {
  const bytes = Buffer.byteLength(line);
  let size = sizes.get(file);
  if (size === undefined) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  if (maxBytes > 0 && size + bytes > maxBytes) {
    rotate(file, keep);
    size = 0;
  }
  fs.appendFileSync(file, line);
  sizes.set(file, size + bytes);
};

/** Read at most the last `maxBytes`, dropping a partial leading record. */
export const readTail = (file, maxBytes) => {
  let fd;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
};
