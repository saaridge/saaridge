#!/usr/bin/env node
/**
 * Mediation guarantee proofs (no Docker required for core cases).
 *
 * 1. Vault at rest is ciphertext (no plaintext substring).
 * 2. resolveVaultRefs decrypts only in-process on the bridge.
 * 3. requiresMediate classifies vault / mediate header → MEDIATE.
 * 4. listMeta never returns value / valueEnc.
 * 5. Data API denies private vault path.
 * 6. network-lock DNS parser pins resolvers (not open 0/0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const { PRIVATE_STATE_DIR } = await import("../host/lib/paths.js");
const { assertNotPrivateVaultPath, defaultDataPolicy } = await import(
  "../host/bridge/data/policy.js"
);
const { assertReadable } = await import("../host/bridge/data/policy.js");

let failed = 0;
const ok = (name) => console.log(`  OK  ${name}`);
const fail = (name, err) => {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.stack || err}`);
};

const agentId = `mediate-test-${process.pid}-${Date.now().toString(36)}`;
const secret = `super-secret-token-${process.pid}-XYZ`;

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
      headers: { "X-OneBridge-Mediate": "1" },
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

console.log("== private path deny ==");
try {
  const agent = { id: agentId, policy: defaultDataPolicy(agentId) };
  let denied = false;
  try {
    assertNotPrivateVaultPath(path.join(PRIVATE_STATE_DIR, "vault", "x.json"));
  } catch (e) {
    if (e.code === "EACCES") denied = true;
    else throw e;
  }
  if (!denied) throw new Error("assertNotPrivateVaultPath did not deny");
  denied = false;
  try {
    assertReadable(agent, path.join(PRIVATE_STATE_DIR, "vault.key"));
  } catch (e) {
    if (e.code === "EACCES") denied = true;
    else throw e;
  }
  if (!denied) throw new Error("assertReadable did not deny vault.key");
  ok("data plane denies private vault");
} catch (e) {
  fail("private path deny", e);
}

console.log("== network-lock DNS pin ==");
try {
  const lock = path.join(ROOT, "container/network-lock.sh");
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
  // Script must not allow bare open :53 — check source contains pin, not 0/0
  const src = fs.readFileSync(lock, "utf8");
  if (/--dport 53 -j ACCEPT/.test(src) && !/DNS_SERVERS/.test(src)) {
    throw new Error("DNS still looks open-any");
  }
  if (!/ip6tables/.test(src)) throw new Error("missing ip6tables hardening");
  ok("network-lock DNS parse + ipv6 present");
  fs.unlinkSync(tmp);
} catch (e) {
  fail("network-lock DNS pin", e);
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
