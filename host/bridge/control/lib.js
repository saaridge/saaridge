/**
 * OneBridge control library — THE place to exercise host + network data control.
 *
 * Edit the hooks below. Return:
 *   { action: "allow", data? | body?, headers?, entries? }
 *   { action: "rewrite", data? | body?, headers?, entries? }
 *   { action: "deny", reason? }
 *
 * Default: identity (pass-through). Framework always calls these for mediated
 * text paths; binary/media and auth MITM passthrough skip this library.
 *
 * DEMO write: append "test" on disk so a save → host → re-read shows mediation.
 * Read is pass-through so an open editor refresh matches host bytes.
 */

const asBuffer = (data) =>
  Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");

const DEMO_WRITE_MARK = Buffer.from("test");

/** Host file read — `data` is Buffer or string. Listings never hit this. */
export async function onFsRead({ agent, path, data }) {
  return { action: "allow", data };
}

/** Host file write — runs before bytes hit disk. */
export async function onFsWrite({ agent, path, data }) {
  const buf = asBuffer(data);
  return {
    action: "rewrite",
    data: Buffer.concat([buf, DEMO_WRITE_MARK]),
  };
}

/**
 * Host directory listing — `entries` is [{ name, ... }].
 * Return rewrite with a filtered/renamed entries array to hide paths.
 */
export async function onFsList({ agent, path, entries }) {
  return { action: "allow", entries };
}

/** Outbound HTTP(S) / tool request — may still contain vault:// markers. */
export async function onNetRequest({ agent, url, method, headers, body }) {
  return { action: "allow", body, headers };
}

/** Inbound HTTP(S) / SSE chunk / WS text frame before the agent sees it. */
export async function onNetResponse({
  agent,
  url,
  method,
  status,
  headers,
  body,
}) {
  return { action: "allow", body, headers };
}
