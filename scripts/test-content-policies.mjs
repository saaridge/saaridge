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
  assert.match(String(phoneHit.data), /\[PHONE\]/);
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
  assert.match(String(result.data), /\[PROTECTED\]/);

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
  assert.match(String(result.data), /\[EMAIL\]/);

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

process.exit(done());
