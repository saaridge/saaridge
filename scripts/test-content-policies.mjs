#!/usr/bin/env node
/**
 * Content policy enforcement tests (categories, modes, smuggling, known values).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "./lib/test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { ok, fail, section, done } = createRunner("content-policies");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saaridge-policy-"));
const configPath = path.join(tmpDir, "ai-policies.json");
process.env.AI_POLICY_CONFIG = configPath;

const {
  resetPolicyEngine,
  setGlobalPolicy,
  setPolicyMode,
  setPolicyCategories,
  setPolicyKnownValues,
  mediateContent,
  listGlobalPolicies,
  getEnabledCategories,
} = await import("../host/lib/ai-policy.js");

const {
  detectSecrets,
  detectPayments,
  detectPersonal,
  detectSmugglingByCategories,
  detectKnownValues,
  pathLooksSensitive,
} = await import("../host/bridge/control/detect/rules.js");

const { onFsList, onFsRead } = await import("../host/bridge/control/lib.js");

section("local detectors");
try {
  const secrets = detectSecrets('token = "sk-abcdefghijklmnopqrstuvwxyz12"');
  assert.ok(secrets.some((s) => s.entity === "CREDENTIAL"));
  const cards = detectPayments("card 4111-1111-1111-1111");
  assert.ok(cards.some((s) => s.entity === "PAYMENT_CARD"));
  // SVG path floats must not Luhn-match as PANs (lichess.org regression).
  const svgPath =
    'd="M38.956.5c-3.53.418-6.452.902-9.286 2.984C5.534 1.786-.692 18.533.68 29.364 3.493 50.214 31.918 55.592 19.996 45.742 27.392 4.683 17.567 9.873 7.742 18.996 4.535 29.03 6.405c2.43-1.418 5.225-3.22 7.655-3.187l-1.694 4.86 12.752 21.37"';
  assert.equal(detectPayments(svgPath).length, 0);
  // Chess piece SVG path crumbs must not match Mastercard 2xxx IINs.
  const pieceSvg =
    'd="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9"';
  assert.equal(detectPayments(pieceSvg).length, 0);
  // Chess FEN / board state must not match as base64 smuggling.
  const fen =
    'data-state="2kr3r/p1p2pp1/2pb4/3n4/NP3P2/P3P1P1/2P1Q3/q1B2RK1 w - - 1 20"';
  assert.equal(
    detectSmugglingByCategories(fen, ["encoded_blobs"]).length,
    0,
  );
  // UTF-8 BOM at start of CSS must not trip obfuscation (lichess lobby.css).
  const cssBom = "\uFEFF.lobby{display:block}";
  assert.equal(
    detectSmugglingByCategories(cssBom, ["obfuscation"]).length,
    0,
  );
  const pii = detectPersonal("email me at alice@example.com please");
  assert.ok(pii.some((s) => s.entity === "EMAIL"));
  assert.ok(pathLooksSensitive(".env"));
  assert.ok(pathLooksSensitive("id_rsa"));
  assert.ok(!pathLooksSensitive("readme.md"));
  const smug = detectSmugglingByCategories("reach me at bob [at] example.com", [
    "encoded_contact",
  ]);
  assert.ok(smug.some((s) => s.entity === "EMAIL"));
  const known = detectKnownValues("Hello Jane Doe today", ["Jane Doe"]);
  assert.ok(known.some((s) => s.entity === "PROTECTED"));
  ok("detectors find secrets, cards, email, paths, smuggling, known values");
} catch (e) {
  fail("local detectors", e);
}

section("policy catalog + all modes");
try {
  resetPolicyEngine();
  const global = listGlobalPolicies();
  const ids = global.map((g) => g.id);
  assert.ok(ids.includes("protect-secrets"));
  assert.ok(ids.includes("block-payment-data"));
  assert.ok(ids.includes("stop-data-smuggling"));
  assert.ok(ids.includes("words-i-protect"));
  assert.equal(ids.length, 6);
  assert.ok(!ids.includes("pii.v1"));
  for (const g of global) {
    assert.deepEqual(g.allowModes, ["redact", "block", "allow"]);
    assert.ok(Array.isArray(g.categories) && g.categories.length > 0);
  }

  setGlobalPolicy("block-payment-data", true);
  setPolicyMode("block-payment-data", "allow");
  const after = listGlobalPolicies().find((g) => g.id === "block-payment-data");
  assert.equal(after.mode, "allow");
  ok("six policies; every policy allows Redact/Block/Allow");
} catch (e) {
  fail("policy catalog + all modes", e);
}

section("redact secrets → vault markers");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-secrets", true);
  setPolicyMode("protect-secrets", "redact");
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("protect-personal-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("words-i-protect", false);
  setGlobalPolicy("hide-sensitive-files", false);

  const body = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz12"';
  const result = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/config.env",
    data: body,
  });
  assert.equal(result.action, "rewrite");
  assert.match(String(result.data), /vault:\/\//);
  ok("Protect Secrets redact rewrites to vault://");
} catch (e) {
  fail("redact secrets", e);
}

section("payment allow free flow");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("block-payment-data", true);
  setPolicyMode("block-payment-data", "allow");
  const body = "card 4111111111111111";
  const result = await mediateContent({
    agentId: "test-agent",
    channel: "net",
    direction: "egress",
    url: "https://example.com",
    method: "POST",
    data: body,
  });
  assert.equal(result.action, "allow");
  assert.equal(String(result.data), body);
  ok("Payment Allow leaves card data untouched");
} catch (e) {
  fail("payment allow", e);
}

section("payment block");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("block-payment-data", true);
  setPolicyMode("block-payment-data", "block");
  const result = await mediateContent({
    agentId: "test-agent",
    channel: "net",
    direction: "egress",
    url: "https://example.com",
    method: "POST",
    data: "card 4111111111111111 cvv 123",
  });
  assert.equal(result.action, "deny");
  ok("Payment Block denies entire request");
} catch (e) {
  fail("payment block", e);
}

section("category exclude");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setPolicyCategories("protect-personal-data", {
    emails: false,
    phones: true,
    ip_addresses: false,
    names_addresses: false,
    birth_dates: false,
    id_docs: false,
    loyalty: false,
  });
  const enabled = getEnabledCategories("protect-personal-data");
  assert.ok(!enabled.includes("emails"));
  assert.ok(enabled.includes("phones"));

  const emailOnly = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/a.txt",
    data: "contact alice@example.com",
  });
  assert.equal(emailOnly.action, "allow");

  const phoneHit = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/a.txt",
    data: "call +1 (415) 555-0100 please",
  });
  assert.equal(phoneHit.action, "rewrite");
  assert.match(String(phoneHit.data), /vault:\/\/phone-/);
  ok("disabling email category skips emails; phones still redact");
} catch (e) {
  fail("category exclude", e);
}

section("known values");
try {
  resetPolicyEngine();
  setGlobalPolicy("words-i-protect", true);
  setPolicyMode("words-i-protect", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("protect-personal-data", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setPolicyKnownValues("words-i-protect", ["Acme Corp"]);

  const result = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/n.txt",
    data: "Invoice for Acme Corp due Friday",
  });
  assert.equal(result.action, "rewrite");
  assert.match(String(result.data), /vault:\/\//);

  setPolicyMode("words-i-protect", "block");
  const blocked = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/n.txt",
    data: "Invoice for Acme Corp due Friday",
  });
  assert.equal(blocked.action, "deny");
  ok("Words I Protect redacts and blocks");
} catch (e) {
  fail("known values", e);
}

section("stop data smuggling");
try {
  resetPolicyEngine();
  setGlobalPolicy("stop-data-smuggling", true);
  setPolicyMode("stop-data-smuggling", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("protect-personal-data", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("words-i-protect", false);

  const result = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/s.txt",
    data: "email bob [at] example.org for details",
  });
  assert.equal(result.action, "rewrite");
  assert.match(String(result.data), /vault:\/\//);

  // Inbound HTML must not be wiped (Google/Cursor login SPA regression).
  setPolicyMode("stop-data-smuggling", "block");
  const b64 =
    "CAMSzgwVzAuqs2zKuK4G2ZH4AKiruwXcrEndkgWnWOBD1QoylhO5EeoepBLVBvoCnAGhFPYC9gPYBQ2SBc4FpgP";
  const html = `<!doctype html><script>window.W="${b64}${b64}"</script>`;
  const netIn = await mediateContent({
    agentId: "test-agent",
    channel: "net",
    direction: "ingress",
    url: "https://www.google.com/",
    method: "GET",
    headers: { "content-type": "text/html" },
    data: html,
  });
  assert.equal(netIn.action, "allow");
  assert.equal(String(netIn.data ?? html), html);

  const htmlEmail = `<!doctype html><p>contact bob [at] example.org</p>`;
  const netEmail = await mediateContent({
    agentId: "test-agent",
    channel: "net",
    direction: "ingress",
    url: "https://cursor.com/loginDeepControl",
    method: "GET",
    headers: { "content-type": "text/html; charset=utf-8" },
    data: htmlEmail,
  });
  assert.notEqual(netEmail.action, "deny");
  assert.ok(String(netEmail.data || "").includes("doctype"));
  ok("Stop Data Smuggling redacts obfuscated email; inbound HTML not blanked");
} catch (e) {
  fail("stop data smuggling", e);
}

section("hide sensitive files redact + block");
try {
  resetPolicyEngine();
  setGlobalPolicy("hide-sensitive-files", true);
  setPolicyMode("hide-sensitive-files", "block");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("stop-data-smuggling", false);

  const agent = { id: "test-agent" };
  const listed = await onFsList({
    agent,
    path: "/tmp",
    entries: [{ name: "readme.md" }, { name: ".env" }, { name: "id_rsa" }],
  });
  assert.equal(listed.action, "rewrite");
  assert.ok(listed.entries.every((e) => e.name !== ".env"));

  setPolicyMode("hide-sensitive-files", "redact");
  const redacted = await onFsList({
    agent,
    path: "/tmp",
    entries: [{ name: "readme.md" }, { name: ".env" }],
  });
  assert.equal(redacted.action, "rewrite");
  assert.ok(redacted.entries.some((e) => e.name === "[hidden-file]"));
  assert.ok(redacted.entries.some((e) => e.name === "readme.md"));

  const read = await onFsRead({
    agent,
    path: "/home/u/.env",
    data: "SECRET=1",
  });
  assert.equal(read.action, "rewrite");
  assert.equal(String(read.data), "[hidden-file]");
  ok("Hide Sensitive Files filters (block) and renames (redact)");
} catch (e) {
  fail("hide sensitive files", e);
}

section("vault releak on egress");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-secrets", true);
  setPolicyMode("protect-secrets", "redact");
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("protect-personal-data", false);
  setGlobalPolicy("words-i-protect", false);

  // First vault a secret via redact ingress
  const vaulted = await mediateContent({
    agentId: "leak-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/k.env",
    data: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz12',
  });
  assert.equal(vaulted.action, "rewrite");

  // Egress with same plaintext should block (redact→block on net egress)
  const leak = await mediateContent({
    agentId: "leak-agent",
    channel: "net",
    direction: "egress",
    url: "https://example.com",
    method: "POST",
    data: "key=sk-abcdefghijklmnopqrstuvwxyz12",
  });
  assert.equal(leak.action, "deny");
  ok("raw secret on egress is denied");
} catch (e) {
  fail("vault releak", e);
}

section("personal data vault id + fs write-back");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("words-i-protect", false);
  setGlobalPolicy("hide-sensitive-files", false);
  setPolicyCategories("protect-personal-data", {
    emails: true,
    phones: true,
    ip_addresses: true,
    names_addresses: true,
    birth_dates: true,
    id_docs: true,
    loyalty: true,
  });

  const { onFsRead, onFsWrite } = await import(
    "../host/bridge/control/pipeline.js"
  );
  const agent = { id: "pii-roundtrip-agent" };
  const original = "owner: alice@example.com\n";
  const read = await onFsRead({
    agent,
    path: "/tmp/contact.txt",
    data: original,
  });
  assert.equal(read.action, "rewrite");
  const mediated = String(read.data);
  assert.match(mediated, /vault:\/\/email-[a-z0-9_-]+/);
  assert.ok(!mediated.includes("alice@example.com"));

  const write = await onFsWrite({
    agent,
    path: "/tmp/contact.txt",
    data: mediated,
  });
  assert.equal(write.action, "rewrite");
  assert.equal(String(write.data), original);
  ok("ingress vault://email-*; egress fs write restores plaintext");
} catch (e) {
  fail("personal data vault id + fs write-back", e);
}

section("policy change busts stale [EMAIL] memo");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("words-i-protect", false);
  setGlobalPolicy("hide-sensitive-files", false);
  setPolicyCategories("protect-personal-data", {
    emails: true,
    phones: true,
    ip_addresses: true,
    names_addresses: true,
    birth_dates: true,
    id_docs: true,
    loyalty: true,
  });

  const fsMemo = await import("../host/bridge/data/fs-memo.js");
  const { read: dataRead } = await import("../host/bridge/data/api.js");
  const { workspaceRootFor } = await import("../host/bridge/data/paths.js");
  const agentId = "memo-agent";
  const ws = workspaceRootFor(agentId);
  fs.mkdirSync(ws, { recursive: true });
  const tmpFile = path.join(ws, "memo-email.txt");
  fs.writeFileSync(tmpFile, "contact alice@example.com\n", "utf8");

  fsMemo.setBodyMemo(
    tmpFile,
    Buffer.from("contact [EMAIL]\n", "utf8"),
    fs.statSync(tmpFile).mtimeMs,
    fs.statSync(tmpFile).size,
  );

  const agent = {
    id: agentId,
    policy: {
      paths: [`~/Saaridge/workspaces/${agentId}`],
      maxReadBytes: 1024 * 1024,
    },
  };
  const first = await dataRead(agent, tmpFile, { encoding: "utf8" });
  assert.match(String(first.content), /vault:\/\/email-/);

  const { invalidateMediationCaches } = await import("../host/lib/ai-policy.js");
  invalidateMediationCaches();
  const second = await dataRead(agent, tmpFile, { encoding: "utf8" });
  assert.match(String(second.content), /vault:\/\/email-/);
  assert.ok(!String(second.content).includes("[EMAIL]"));
  ok("legacy placeholder memo is ignored; reads re-vault");
} catch (e) {
  fail("policy change busts stale memo", e);
}

section("chunked read still vaults email");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("words-i-protect", false);
  setGlobalPolicy("hide-sensitive-files", false);
  setPolicyCategories("protect-personal-data", {
    emails: true,
    phones: true,
    ip_addresses: true,
    names_addresses: true,
    birth_dates: true,
    id_docs: true,
    loyalty: true,
  });

  const { read: dataRead } = await import("../host/bridge/data/api.js");
  const { workspaceRootFor } = await import("../host/bridge/data/paths.js");
  const agentId = "chunk-read-agent";
  const ws = workspaceRootFor(agentId);
  fs.mkdirSync(ws, { recursive: true });
  const tmpFile = path.join(ws, "chunk-email.txt");
  fs.writeFileSync(tmpFile, "header\nemail: alice@example.com\nfooter\n", "utf8");
  const agent = {
    id: agentId,
    policy: {
      paths: [`~/Saaridge/workspaces/${agentId}`],
      maxReadBytes: 1024 * 1024,
    },
  };
  await dataRead(agent, tmpFile, { offset: 0, length: 8, encoding: "utf8" });
  const full = await dataRead(agent, tmpFile, { encoding: "utf8" });
  assert.match(String(full.content), /vault:\/\/email-/);
  assert.ok(!String(full.content).includes("alice@example.com"));
  ok("partial read first; full read still gets vault://email-*");
} catch (e) {
  fail("chunked read vault email", e);
}

// A vault:// marker is longer than the email it replaces, and the read length
// defaulted to the raw host size — so a whole-file read came back cut off mid
// marker ("vault://email-dac6cfd"), which nothing can resolve back. stat must
// also report the mediated length, or FUSE's attr.size clamps the read again.
section("mediated text longer than the file is not truncated");
try {
  resetPolicyEngine();
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "redact");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("stop-data-smuggling", false);
  setGlobalPolicy("words-i-protect", false);
  setGlobalPolicy("hide-sensitive-files", false);

  const { read: dataRead, stat: dataStat } = await import(
    "../host/bridge/data/api.js"
  );
  const { workspaceRootFor } = await import("../host/bridge/data/paths.js");
  const agentId = "grow-read-agent";
  const ws = workspaceRootFor(agentId);
  fs.mkdirSync(ws, { recursive: true });
  const tmpFile = path.join(ws, "grow-email.txt");
  const original = "contact: jane.doe@example.com\n";
  fs.writeFileSync(tmpFile, original, "utf8");
  const agent = {
    id: agentId,
    policy: {
      paths: [`~/Saaridge/workspaces/${agentId}`],
      maxReadBytes: 1024 * 1024,
    },
  };

  // Cold read (nothing memoized yet) must already return the whole marker.
  const cold = await dataRead(agent, tmpFile, { encoding: "utf8" });
  const coldText = String(cold.content);
  assert.match(coldText, /vault:\/\/email-[0-9a-f]{16}/, `cold read: ${coldText}`);
  assert.ok(
    coldText.length > original.length,
    `mediated text should be longer than ${original.length}, got ${coldText.length}`,
  );
  assert.ok(coldText.endsWith("\n"), "trailing newline must survive");

  // stat must advertise the mediated length so FUSE does not clamp the read.
  const st = await dataStat(agent, tmpFile);
  assert.equal(
    st.size,
    Buffer.byteLength(coldText, "utf8"),
    "stat must report the mediated size",
  );
  assert.equal(st.rawSize, original.length, "raw size stays available");

  // Warm read goes through the memo and must match the cold read exactly.
  const warm = await dataRead(agent, tmpFile, { encoding: "utf8" });
  assert.equal(String(warm.content), coldText, "warm read must not differ");

  // The case that actually reached users: a policy change drops the memo, and
  // FUSE stats before it reads. That stat must already report the mediated size,
  // or the kernel clamps the one read the agent makes and cuts the marker.
  const { bustAll } = await import("../host/bridge/data/fs-memo.js");
  bustAll("test-cold-stat");
  const coldStat = await dataStat(agent, tmpFile);
  assert.equal(
    coldStat.size,
    Buffer.byteLength(coldText, "utf8"),
    "stat with an empty memo must still report the mediated size",
  );
  const afterColdStat = await dataRead(agent, tmpFile, {
    offset: 0,
    length: coldStat.size,
    encoding: "utf8",
  });
  assert.equal(
    String(afterColdStat.content),
    coldText,
    "read of stat-reported length must return the whole marker",
  );
  ok("grown mediated body is returned whole; cold stat reports mediated size");
} catch (e) {
  fail("mediated text truncation", e);
}

// Setting Protect Personal Data to Allow must actually show plain emails. It did
// not, because EMAIL_OBFUSCATED also matched a bare `@`, so Stop Data Smuggling
// (encoded_contact, redact) kept vaulting ordinary emails. Each detector must own
// its own shape: plain `a@b.com` is personal data, disguised forms are smuggling.
section("Allow on personal data is not overridden by smuggling");
try {
  const { detectPersonalByCategories, detectSmugglingByCategories } =
    await import("../host/bridge/control/detect/rules.js");

  const smug = (t) =>
    detectSmugglingByCategories(t, [
      "encoded_contact",
      "encoded_blobs",
      "obfuscation",
    ]).length;
  const pers = (t) => detectPersonalByCategories(t, ["emails"]).length;

  // Plain email: personal data only.
  assert.equal(pers("contact: jane.doe@example.com"), 1);
  assert.equal(smug("contact: jane.doe@example.com"), 0);
  assert.equal(pers("mail me at bob@corp.co today"), 1);
  assert.equal(smug("mail me at bob@corp.co today"), 0);

  // Disguised forms stay smuggling, including a spaced `@` (still a dodge).
  for (const t of [
    "contact: jane.doe [at] example.com",
    "contact: jane.doe (at) example.com",
    "contact: jane.doe at example.com",
    "contact: jane.doe @ example.com",
    "contact: jane.doe @example.com",
    "contact: jane.doe@ example.com",
  ]) {
    assert.equal(smug(t), 1, `expected smuggling hit for ${JSON.stringify(t)}`);
  }

  // End to end: Allow on personal data with smuggling still redacting must
  // return the plain email untouched.
  resetPolicyEngine();
  setGlobalPolicy("stop-data-smuggling", true);
  setPolicyMode("stop-data-smuggling", "redact");
  setGlobalPolicy("protect-personal-data", true);
  setPolicyMode("protect-personal-data", "allow");
  setGlobalPolicy("protect-secrets", false);
  setGlobalPolicy("block-payment-data", false);
  setGlobalPolicy("hide-sensitive-files", false);
  setGlobalPolicy("words-i-protect", false);

  const plain = "contact: jane.doe@example.com\n";
  const allowed = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/allow-personal.txt",
    data: plain,
  });
  const allowedText = Buffer.isBuffer(allowed.data)
    ? allowed.data.toString("utf8")
    : String(allowed.data ?? "");
  assert.equal(
    allowedText,
    plain,
    "Allow on personal data must return the plain email",
  );
  assert.doesNotMatch(allowedText, /vault:\/\//);

  // ...and Redact must still vault it, so Allow is a real switch.
  setPolicyMode("protect-personal-data", "redact");
  const redacted = await mediateContent({
    agentId: "test-agent",
    channel: "fs",
    direction: "ingress",
    path: "/tmp/allow-personal.txt",
    data: plain,
  });
  const redactedText = Buffer.isBuffer(redacted.data)
    ? redacted.data.toString("utf8")
    : String(redacted.data ?? "");
  assert.match(redactedText, /vault:\/\/email-/);
  ok("Allow shows plain emails; Redact still vaults them");
} catch (e) {
  fail("allow personal data not overridden", e);
}

section("policy bust marker for FUSE invalidate");
try {
  const { POLICY_BUST_MARKER, bustAll, getEventsSince } = await import(
    "../host/bridge/data/fs-memo.js"
  );
  bustAll("test");
  const ev = getEventsSince(0);
  const paths = (ev.events || []).map((e) => e.path);
  if (!paths.includes(POLICY_BUST_MARKER)) {
    throw new Error(`expected ${POLICY_BUST_MARKER} in fs events`);
  }
  ok("bustAll emits FUSE policy invalidate marker");
} catch (e) {
  fail("policy bust marker", e);
}

process.exit(done());
