#!/usr/bin/env node
/**
 * Mediation guarantee proofs (no Docker required for core cases).
 *
 * 1. Vault at rest is ciphertext (no plaintext substring).
 * 2. resolveVaultRefs decrypts only in-process on the bridge.
 * 3. requiresMediate classifies vault / mediate header → MEDIATE.
 * 4. listMeta never returns value / valueEnc.
 * 5. Data API denies bridge STATE_DIR (tokens, MITM keys, vault) including link escapes.
 * 5b. list/tree omit STATE_DIR metadata (no vault.key / token / mitm browse leak).
 * 6. network-lock DNS parser pins resolvers; control plane :3847 not allowed from container.
 * 7. Adaptive media rejection requires media-shaped signals (not Range alone).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Isolate vault files under a temp STATE_DIR via env override of key path:
// vault modules import STATE_DIR at load time — use unique agent id + cleanup.
const { put, get, listMeta, resolveVaultRefs, vaultFilePath } = await import(
  "../host/bridge/vault/index.js"
);
const { requiresMediate, hasVaultRefs } = await import(
  "../host/bridge/vault/markers.js"
);
const { looksEncrypted } = await import("../host/bridge/vault/crypto.js");
const { PRIVATE_STATE_DIR, STATE_DIR, VAULT_KEY_PATH } = await import(
  "../host/lib/paths.js"
);
const {
  assertNotPrivateVaultPath,
  defaultDataPolicy,
  assertReadable,
  refreshBridgeStateInodes,
  isBridgeStatePath,
  filterBridgeStateListing,
} = await import("../host/bridge/data/policy.js");
const { workspaceRootFor } = await import("../host/bridge/data/paths.js");
const { list: dataList, tree: dataTree } = await import(
  "../host/bridge/data/api.js"
);
const {
  looksLikeMitmMediaRejection,
  tryDecodeCompressedBody,
  decodeChunkedBody,
  mediationErrorResult,
  mediateStreamText,
  adaptiveTtlMsForReason,
} = await import("../host/bridge/proxy.js");
const {
  shouldProcessNetText,
  isOpaqueRpcContentType,
  shouldStreamOpaqueBody,
} = await import("../host/bridge/transformers/text.js");

let failed = 0;
const ok = (name) => console.log(`  OK  ${name}`);
const fail = (name, err) => {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.stack || err}`);
};

const agentId = `mediate-test-${process.pid}-${Date.now().toString(36)}`;
const secret = `super-secret-token-${process.pid}-XYZ`;

console.log("== opaque RPC content types ==");
try {
  const grpc = { "content-type": "application/grpc" };
  const connect = { "content-type": "application/connect+proto" };
  const proto = { "content-type": "application/x-protobuf" };
  const json = { "content-type": "application/json" };
  if (!isOpaqueRpcContentType(grpc["content-type"])) {
    throw new Error("grpc must be opaque rpc");
  }
  if (shouldProcessNetText(grpc, Buffer.from([0, 1, 2, 3, 4]))) {
    throw new Error("grpc must not be text-mediated");
  }
  if (!shouldStreamOpaqueBody(grpc, 100)) {
    throw new Error("grpc must stream opaque");
  }
  if (!isOpaqueRpcContentType(connect["content-type"])) {
    throw new Error("connect+proto must be opaque");
  }
  if (shouldProcessNetText(connect, "not-really-text-\0")) {
    throw new Error("connect must not be text-mediated");
  }
  if (!isOpaqueRpcContentType(proto["content-type"])) {
    throw new Error("protobuf must be opaque");
  }
  if (!shouldProcessNetText(json, '{"a":1}')) {
    throw new Error("json must still be text-mediated");
  }
  ok("opaque gRPC/Connect/protobuf; json still mediated");
} catch (e) {
  fail("opaque RPC content types", e);
}

console.log("== adaptive TTL (UNKNOWN_CA same long window) ==");
try {
  const unknownTtl = adaptiveTtlMsForReason(
    "tls_client_error:ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  );
  const challengeTtl = adaptiveTtlMsForReason("mitm_blocking_challenge");
  const opaqueTtl = adaptiveTtlMsForReason("mitm_opaque_rpc");
  if (unknownTtl !== challengeTtl || opaqueTtl !== challengeTtl) {
    throw new Error(
      `expected equal long TTLs, got unknown=${unknownTtl} challenge=${challengeTtl} opaque=${opaqueTtl}`,
    );
  }
  if (unknownTtl !== 6 * 60 * 60 * 1000) {
    throw new Error(`expected 6h adaptive TTL, got ${unknownTtl}`);
  }
  ok("adaptive TTL is long for UNKNOWN_CA and opaque RPC");
} catch (e) {
  fail("adaptive TTL", e);
}

console.log("== clipboard ingress mediation ==");
try {
  const { onClipboardIngress } = await import(
    "../host/bridge/control/pipeline.js"
  );
  const allow = await onClipboardIngress({
    agent: { id: agentId },
    text: "hello clipboard",
  });
  if (allow.action === "deny") {
    throw new Error(`unexpected deny: ${allow.reason}`);
  }
  if (String(allow.text || "") !== "hello clipboard" && allow.action === "allow") {
    throw new Error(`expected hello clipboard, got ${JSON.stringify(allow)}`);
  }
  // Fail-closed shape: deny always clears text
  const secretish = await onClipboardIngress({
    agent: { id: agentId },
    text: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
  });
  if (secretish.action === "deny" && secretish.text !== "") {
    throw new Error("deny must clear clipboard text");
  }
  ok("onClipboardIngress allow path + deny clears text");
} catch (e) {
  fail("clipboard ingress mediation", e);
}

console.log("== vault encryption ==");
try {
  const id = put(agentId, {
    kind: "test",
    name: "tok",
    value: secret,
    sourcePath: "/tmp/test",
  });
  if (!id || !/^[a-f0-9]+$/i.test(id)) throw new Error(`bad id ${id}`);
  const file = vaultFilePath(agentId);
  const raw = fs.readFileSync(file, "utf8");
  if (raw.includes(secret)) {
    throw new Error("plaintext secret found on disk");
  }
  const parsed = JSON.parse(raw);
  const row = parsed.secrets[id];
  if (!row?.valueEnc) throw new Error("missing valueEnc");
  if (row.value) throw new Error("plaintext value field persisted");
  if (!looksEncrypted(row.valueEnc)) throw new Error("valueEnc not encrypted format");
  ok("put stores ciphertext only");

  const got = get(agentId, id);
  if (!got || got.value !== secret) throw new Error("decrypt mismatch");
  ok("get decrypts on bridge");

  const resolved = resolveVaultRefs(agentId, `Bearer vault://${id}`);
  if (resolved !== `Bearer ${secret}`) throw new Error(`resolve got ${resolved}`);
  ok("resolveVaultRefs injects plaintext in-process");

  const meta = listMeta(agentId);
  const m = meta.find((x) => x.id === id);
  if (!m) throw new Error("meta missing");
  if ("value" in m || "valueEnc" in m) {
    throw new Error("listMeta leaked value fields");
  }
  ok("listMeta is metadata-only");
} catch (e) {
  fail("vault encryption", e);
}

console.log("== mediate classifier ==");
try {
  if (!requiresMediate({ url: "https://api.example/x", headers: {}, body: "" })) {
    /* ok — no markers */
  } else throw new Error("empty should not mediate");
  if (
    !requiresMediate({
      url: "https://api.example/x",
      headers: { Authorization: "Bearer vault://deadbeef" },
      body: "",
    })
  ) {
    throw new Error("header vault should mediate");
  }
  if (
    !requiresMediate({
      url: "https://api.example/?t=vault://aabbccdd",
      headers: {},
      body: "",
    })
  ) {
    throw new Error("url vault should mediate");
  }
  if (
    !requiresMediate({
      url: "https://api.example/",
      headers: { "X-Saaridge-Mediate": "1" },
      body: "",
    })
  ) {
    throw new Error("mediate header should mediate");
  }
  if (requiresMediate({ url: "https://ok.example/", headers: {}, body: "hello" })) {
    throw new Error("plain body should TUNNEL-ok");
  }
  if (!hasVaultRefs("vault://abc123")) throw new Error("hasVaultRefs");
  ok("requiresMediate / hasVaultRefs");
} catch (e) {
  fail("mediate classifier", e);
}

console.log("== bridge state path deny ==");
try {
  const agent = { id: agentId, policy: defaultDataPolicy(agentId) };
  const mustDeny = (label, p) => {
    let denied = false;
    try {
      assertReadable(agent, p);
    } catch (e) {
      if (e.code === "EACCES") denied = true;
      else throw e;
    }
    if (!denied) throw new Error(`expected deny for ${label}: ${p}`);
  };

  mustDeny("vault.key", path.join(PRIVATE_STATE_DIR, "vault.key"));
  mustDeny("agents.json", path.join(STATE_DIR, "agents.json"));
  mustDeny("ca.key", path.join(STATE_DIR, "mitm-certs", "ca.key"));
  mustDeny("bridge.token", path.join(STATE_DIR, "bridge.token"));

  let denied = false;
  try {
    assertNotPrivateVaultPath(path.join(PRIVATE_STATE_DIR, "vault", "x.json"));
  } catch (e) {
    if (e.code === "EACCES") denied = true;
    else throw e;
  }
  if (!denied) throw new Error("assertNotPrivateVaultPath did not deny");
  ok("data plane denies STATE_DIR secrets");

  // Symlink escape from workspace → vault.key
  const ws = workspaceRootFor(agentId);
  fs.mkdirSync(ws, { recursive: true });
  const linkPath = path.join(ws, "vault-key-link");
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* ignore */
  }
  const keyTarget = fs.existsSync(VAULT_KEY_PATH)
    ? VAULT_KEY_PATH
    : path.join(PRIVATE_STATE_DIR, "vault.key");
  if (!fs.existsSync(keyTarget)) {
    fs.mkdirSync(path.dirname(keyTarget), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyTarget, "test-key-material", { mode: 0o600 });
  }
  fs.symlinkSync(keyTarget, linkPath);
  refreshBridgeStateInodes();
  mustDeny("symlink→vault.key", linkPath);
  fs.unlinkSync(linkPath);
  ok("symlink to vault.key denied");

  // Hardlink escape
  const hardPath = path.join(ws, "vault-hard-link");
  try {
    fs.unlinkSync(hardPath);
  } catch {
    /* ignore */
  }
  try {
    fs.linkSync(keyTarget, hardPath);
    refreshBridgeStateInodes();
    mustDeny("hardlink→vault.key", hardPath);
    fs.unlinkSync(hardPath);
    ok("hardlink to vault.key denied");
  } catch (e) {
    if (e.code === "EACCES" && String(e.message).includes("Bridge state")) {
      try {
        fs.unlinkSync(hardPath);
      } catch {
        /* ignore */
      }
      ok("hardlink to vault.key denied");
    } else if (/EXDEV|EPERM|ENOTSUP|operation not permitted/i.test(e.message || e.code)) {
      ok(`hardlink skip (${e.code || e.message})`);
    } else {
      throw e;
    }
  }

  try {
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
} catch (e) {
  fail("bridge state path deny", e);
}

console.log("== list/tree omit STATE_DIR metadata ==");
try {
  if (!isBridgeStatePath(STATE_DIR)) {
    throw new Error("isBridgeStatePath(STATE_DIR) should be true");
  }
  if (!isBridgeStatePath(path.join(STATE_DIR, "private", "vault.key"))) {
    throw new Error("isBridgeStatePath(vault.key) should be true");
  }
  if (isBridgeStatePath(path.join(ROOT, "host"))) {
    throw new Error("isBridgeStatePath(host/) must be false");
  }

  const filtered = filterBridgeStateListing(ROOT, [
    { name: "host", path: path.join(ROOT, "host") },
    { name: "state", path: path.join(ROOT, "state") },
    { name: "package.json", path: path.join(ROOT, "package.json") },
  ]);
  if (filtered.some((e) => e.name === "state")) {
    throw new Error("filterBridgeStateListing must drop STATE_DIR child");
  }
  if (!filtered.some((e) => e.name === "host")) {
    throw new Error("filterBridgeStateListing must keep non-state children");
  }

  const agent = { id: agentId, policy: defaultDataPolicy(agentId) };
  const listed = await dataList(agent, ROOT, { shallow: true, withStats: false });
  const names = (listed.entries || []).map((e) => e.name);
  if (names.includes("state")) {
    throw new Error(`list(ROOT) must omit state/; got ${names.join(",")}`);
  }

  const treed = await dataTree(agent, ROOT, { maxDepth: 5, maxEntries: 9000 });
  const rels = (treed.entries || []).map((e) => e.rel || e.name);
  const leaks = rels.filter(
    (r) =>
      r === "state" ||
      String(r).startsWith("state/") ||
      String(r).includes("vault.key") ||
      String(r).includes("bridge.token") ||
      String(r).includes("mitm-certs/ca.key"),
  );
  if (leaks.length) {
    throw new Error(`tree(ROOT) leaked bridge state: ${leaks.slice(0, 10).join(", ")}`);
  }
  ok("list/tree omit STATE_DIR (vault.key, token, mitm)");
} catch (e) {
  fail("list/tree omit STATE_DIR", e);
}

console.log("== network-lock DNS pin + no control plane ==");
try {
  const lock = path.join(ROOT, "container/network-lock.sh");
  const src = fs.readFileSync(lock, "utf8");
  if (/--dport "\$CONTROL_PORT"/.test(src) || /--dport "\$\{CONTROL_PORT\}"/.test(src)) {
    throw new Error("network-lock still allows CONTROL_PORT");
  }
  if (/CONTROL_PORT=.*3847/.test(src) && /dport.*CONTROL_PORT/.test(src)) {
    throw new Error("CONTROL_PORT still wired into iptables accepts");
  }
  // Must not ACCEPT tcp/3847 to bridge
  if (/--dport ["']?3847/.test(src)) {
    throw new Error("network-lock still has explicit :3847 accept");
  }
  if (!/host-only/i.test(src)) {
    throw new Error("network-lock should document control plane as host-only");
  }

  const tmp = path.join(os.tmpdir(), `ob-resolv-${process.pid}.conf`);
  fs.writeFileSync(
    tmp,
    "nameserver 1.1.1.1\nnameserver 8.8.8.8\n# comment\nnameserver not-an-ip\n",
  );
  const r = spawnSync(lock, ["--print-dns", tmp], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  const lines = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.includes("1.1.1.1") || !lines.includes("8.8.8.8")) {
    throw new Error(`unexpected dns parse: ${JSON.stringify(lines)}`);
  }
  if (lines.includes("not-an-ip")) throw new Error("accepted junk nameserver");

  if (process.platform === "linux") {
    const lockScript = path.join(ROOT, "container", "network-lock.sh");
    const noDns = spawnSync(lockScript, [], {
      encoding: "utf8",
      env: { ...process.env, RESOLV_CONF: "/nonexistent" },
    });
    if (!/no nameserver entries/i.test(noDns.stderr || "")) {
      throw new Error("network-lock must fail closed without resolv.conf nameservers");
    }
    ok("network-lock DNS parse + no :3847 + fail-closed without resolvers");
  } else {
    ok("network-lock DNS parse + no :3847 (iptables live check skipped on non-Linux)");
  }
  fs.unlinkSync(tmp);
} catch (e) {
  fail("network-lock DNS pin + no control plane", e);
}

console.log("== adaptive media heuristic ==");
try {
  if (
    looksLikeMitmMediaRejection(401, {}, {
      url: "/v1/me",
      headers: { range: "bytes=0-1" },
    })
  ) {
    throw new Error("Range+401 alone must not mark adaptive");
  }
  if (
    !looksLikeMitmMediaRejection(403, {}, {
      url: "/videoplayback?id=1",
      headers: {},
    })
  ) {
    throw new Error("video URL + 403 should mark");
  }
  if (
    !looksLikeMitmMediaRejection(403, {}, {
      url: "/api/stream",
      headers: { accept: "video/*" },
    })
  ) {
    throw new Error("Accept video/* + 403 should mark");
  }
  if (
    !looksLikeMitmMediaRejection(
      401,
      { "content-type": "audio/mpeg" },
      { url: "/x", headers: {} },
    )
  ) {
    throw new Error("audio Content-Type + 401 should mark");
  }
  ok("looksLikeMitmMediaRejection tightened");
} catch (e) {
  fail("adaptive media heuristic", e);
}

console.log("== gzip decode helper ==");
try {
  const plain = Buffer.from('{"token":"sk-testabcdefghijklmnop"}', "utf8");
  const gz = zlib.gzipSync(plain);
  const decoded = tryDecodeCompressedBody(
    { "content-encoding": "gzip", "content-type": "application/json" },
    gz,
  );
  if (!decoded || decoded.toString("utf8") !== plain.toString("utf8")) {
    throw new Error("gunzip round-trip failed");
  }
  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 10, 1);
  if (tryDecodeCompressedBody({ "content-encoding": "gzip" }, tooBig) != null) {
    throw new Error("oversized body should not decode");
  }
  ok("tryDecodeCompressedBody gunzip + size cap");
} catch (e) {
  fail("gzip decode helper", e);
}

console.log("== brotli decode helper ==");
try {
  const plain = Buffer.from('{"ok":true,"secret":"sk-brotlitestvalue12"}', "utf8");
  const br = zlib.brotliCompressSync(plain);
  const decoded = tryDecodeCompressedBody(
    { "content-encoding": "br", "content-type": "application/json" },
    br,
  );
  if (!decoded || decoded.toString("utf8") !== plain.toString("utf8")) {
    throw new Error("brotli round-trip failed");
  }
  ok("tryDecodeCompressedBody brotli");
} catch (e) {
  fail("brotli decode helper", e);
}

console.log("== chunked body decode ==");
try {
  const payload = Buffer.from('{"a":1}', "utf8");
  const chunked = Buffer.concat([
    Buffer.from(`${payload.length.toString(16)}\r\n`, "latin1"),
    payload,
    Buffer.from("\r\n0\r\n\r\n", "latin1"),
  ]);
  const assembled = decodeChunkedBody(chunked);
  if (!assembled?.complete) throw new Error("expected complete chunked body");
  if (assembled.body.toString("utf8") !== '{"a":1}') {
    throw new Error(`bad body ${assembled.body}`);
  }
  if (assembled.framedBytes !== chunked.length) {
    throw new Error(`framedBytes ${assembled.framedBytes} != ${chunked.length}`);
  }
  const partial = chunked.slice(0, 4);
  if (decodeChunkedBody(partial) != null) {
    throw new Error("partial chunked should be incomplete");
  }
  ok("decodeChunkedBody assemble + incomplete");
} catch (e) {
  fail("chunked body decode", e);
}

console.log("== mediation fail-closed helper ==");
try {
  const out = mediationErrorResult({
    body: "SECRET",
    headers: { a: "1" },
    host: "x.test",
  });
  if (!out.denied || out.denyReason !== "mediation_error") {
    throw new Error("expected denied mediation_error");
  }
  if (out.body !== "") throw new Error("body must be cleared");
  ok("mediationErrorResult fail-closed");
} catch (e) {
  fail("mediation fail-closed helper", e);
}

console.log("== WS/SSE mediateStreamText ==");
try {
  const agent = { id: agentId };
  const plain = "hello stream mediation";
  const allowed = await mediateStreamText({
    agent,
    host: "example.test",
    direction: "ingress",
    text: plain,
    channel: "ws",
  });
  if (allowed !== plain) {
    throw new Error(`allow path changed text: ${JSON.stringify(allowed)}`);
  }
  ok("mediateStreamText allow path unchanged");

  const vaulted = await mediateStreamText({
    agent,
    host: "example.test",
    direction: "egress",
    text: `use vault://abcdef0123456789 please`,
    channel: "ws",
  });
  if (vaulted !== "") {
    throw new Error(`vault refs must clear unit, got ${JSON.stringify(vaulted)}`);
  }
  ok("mediateStreamText clears unresolved vault://");

  const sseVault = await mediateStreamText({
    agent,
    host: "example.test",
    direction: "ingress",
    text: "data: vault://deadbeef\n\n",
    channel: "sse",
  });
  if (sseVault !== "") {
    throw new Error(`SSE vault refs must clear, got ${JSON.stringify(sseVault)}`);
  }
  ok("mediateStreamText SSE clears vault://");

  // Egress + Protect Secrets (default redact→block on net egress): secret unit cleared.
  const secretFrame = await mediateStreamText({
    agent,
    host: "api.example.test",
    direction: "egress",
    text: 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    channel: "ws",
  });
  if (secretFrame !== "") {
    throw new Error(
      `egress secret must clear/block unit, got ${JSON.stringify(secretFrame)}`,
    );
  }
  if (secretFrame.includes("sk-ant")) {
    throw new Error("egress must never forward raw secret");
  }
  ok("mediateStreamText egress secret cleared");

  // Fail-closed on throw: inject throwing lib; original must not leak.
  const throwingLib = {
    onNetRequest: async () => {
      throw new Error("forced mediation failure");
    },
    onNetResponse: async () => {
      throw new Error("forced mediation failure");
    },
  };
  const leaked = "SUPER-SECRET-MUST-NOT-LEAK";
  const outThrow = await mediateStreamText({
    agent,
    host: "example.test",
    direction: "egress",
    text: leaked,
    channel: "ws",
    _lib: throwingLib,
  });
  if (outThrow !== "") {
    throw new Error(`throw path must return empty, got ${JSON.stringify(outThrow)}`);
  }
  ok("mediateStreamText fail-closed on throw");
} catch (e) {
  fail("WS/SSE mediateStreamText", e);
}

console.log("== hardlink inode miss refresh ==");
try {
  const agent = { id: agentId, policy: defaultDataPolicy(agentId) };
  const ws = workspaceRootFor(`${agentId}-inode-miss`);
  fs.mkdirSync(ws, { recursive: true });
  refreshBridgeStateInodes(); // warm stale cache
  const spooky = path.join(STATE_DIR, `inode-miss-${process.pid}.txt`);
  fs.writeFileSync(spooky, "LEAKME-INODE-MISS");
  const hl = path.join(ws, "hl-miss");
  try {
    fs.unlinkSync(hl);
  } catch {
    /* ignore */
  }
  fs.linkSync(spooky, hl);
  // Do NOT refresh manually — nlink>1 path must refresh and deny.
  let denied = false;
  try {
    assertReadable(agent, hl);
  } catch (e) {
    if (e.code === "EACCES") denied = true;
    else throw e;
  }
  if (!denied) throw new Error("stale inode cache still allowed hardlink read");
  fs.unlinkSync(hl);
  fs.unlinkSync(spooky);
  fs.rmSync(ws, { recursive: true, force: true });
  ok("hardlink after cache warm denied via nlink refresh");
} catch (e) {
  fail("hardlink inode miss refresh", e);
}

// Cleanup test vault file (best-effort)
try {
  const f = vaultFilePath(agentId);
  if (fs.existsSync(f)) fs.unlinkSync(f);
} catch {
  /* ignore */
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll mediation guarantee checks passed.");
