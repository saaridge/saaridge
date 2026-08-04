#!/usr/bin/env node
/** Audit sanitize: vault plaintext must not reach agent-facing audit. */
import assert from "node:assert/strict";
import {
  sanitizeNetAuditEntry,
  sanitizeAuditForAgent,
} from "../host/bridge/data/audit-sanitize.js";
import { createRunner } from "./lib/test-harness.mjs";

const { ok, fail, section, done } = createRunner("audit-sanitize");

section("vault-bearing redact");
try {
  const entry = sanitizeNetAuditEntry({
    plane: "net",
    op: "net_request",
    vaultResolved: true,
    hadVault: true,
    host: "example.com",
    headers: { authorization: "Bearer SUPERSECRET", "content-type": "application/json" },
    body: '{"token":"SUPERSECRET"}',
    url: "https://example.com/x?key=SUPERSECRET",
  });
  assert.equal(entry.body, "<redacted vault-bearing body>");
  assert.equal(entry.headers.authorization, "<redacted>");
  assert.match(String(entry.url), /redacted-query/);
  assert.ok(!String(entry.body).includes("SUPERSECRET"));
  ok("sanitizeNetAuditEntry strips resolved secrets");
} catch (e) {
  fail("vault-bearing redact", e);
}

section("agent view omits large bodies");
try {
  const big = sanitizeAuditForAgent({
    plane: "net",
    op: "net_response",
    host: "example.com",
    body: "x".repeat(500),
  });
  assert.match(String(big.body), /omitted/);
  ok("sanitizeAuditForAgent omits large non-vault bodies");
} catch (e) {
  fail("agent view", e);
}

done();
