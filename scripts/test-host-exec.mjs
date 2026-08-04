#!/usr/bin/env node
/** host_exec mediation + no-elevation + STATE_DIR seal proofs */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunner } from "./lib/test-harness.mjs";
import {
  assertNoElevation,
  assertNoBridgeStateAccess,
  runHostExec,
} from "../host/bridge/host-exec.js";
import { getAgentById, createAgentCredential, removeAgentRecord } from "../host/lib/auth.js";
import { STATE_DIR, VAULT_KEY_PATH } from "../host/lib/paths.js";

const { ok, fail, section, done } = createRunner("host-exec");

section("no elevation");
try {
  assert.throws(() => assertNoElevation("sudo ls"), /elevation/);
  assert.throws(() => assertNoElevation("doas id"), /elevation/);
  assert.throws(() => assertNoElevation("su -"), /elevation/);
  assertNoElevation("ls -la");
  ok("sudo/su/doas denied; plain commands allowed");
} catch (e) {
  fail("no elevation", e);
}

section("bridge state precheck");
try {
  assert.throws(
    () => assertNoBridgeStateAccess(`cat ${VAULT_KEY_PATH}`),
    /bridge state/,
  );
  assert.throws(
    () => assertNoBridgeStateAccess(`wc -c ${path.join(STATE_DIR, "bridge.token")}`),
    /bridge state/,
  );
  assert.throws(
    () => assertNoBridgeStateAccess("head state/private/vault.key"),
    /bridge state/,
  );
  assert.throws(
    () => assertNoBridgeStateAccess("cat ~/.ssh/id_rsa"),
    /denies/,
  );
  assertNoBridgeStateAccess("uname -s");
  assertNoBridgeStateAccess("ls package.json");
  ok("STATE_DIR path mentions denied; normal commands allowed");
} catch (e) {
  fail("bridge state precheck", e);
}

section("no ssh agent env");
try {
  const existing = getAgentById("workspace-desktop");
  const agent =
    existing ||
    createAgentCredential({ id: `host-exec-env-${Date.now()}`, name: "host-exec-env" });
  const result = await runHostExec(agent, {
    command: 'echo SOCK=${SSH_AUTH_SOCK:-EMPTY}',
    timeoutMs: 10_000,
  });
  assert.match(result.stdout, /SOCK=EMPTY/);
  ok("SSH_AUTH_SOCK not passed into host_exec");
  if (!existing) {
    try {
      removeAgentRecord(agent.id);
    } catch {
      /* ignore */
    }
  }
} catch (e) {
  fail("no ssh agent env", e);
}

section("mediated host run");
let agentId = null;
try {
  const existing = getAgentById("workspace-desktop");
  const agent =
    existing ||
    createAgentCredential({ id: `host-exec-test-${Date.now()}`, name: "host-exec-test" });
  agentId = existing ? null : agent.id;
  const result = await runHostExec(agent, {
    command: "uname -s && pwd && id -un",
    timeoutMs: 15_000,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Darwin|Linux|Windows_NT/);
  assert.ok(result.cwd.includes("OneBridge") || result.cwd.startsWith(os.homedir()));
  assert.equal(result.stdoutDenied, false);
  if (process.platform === "darwin") {
    assert.equal(result.sandboxed, true);
  }
  ok("host_exec runs as host user with mediated stdout");

  let denied = false;
  try {
    await runHostExec(agent, { command: "sudo -n true" });
  } catch (e) {
    if (/elevation|EACCES|denied/i.test(String(e.message))) denied = true;
    else throw e;
  }
  assert.ok(denied);
  ok("host_exec rejects sudo");

  // Precheck: explicit vault.key path must throw before spawn.
  let vaultDenied = false;
  try {
    await runHostExec(agent, {
      command: `wc -c ${VAULT_KEY_PATH}; head -c 20 ${VAULT_KEY_PATH} | xxd`,
      timeoutMs: 10_000,
    });
  } catch (e) {
    if (/bridge state|EACCES|denied/i.test(String(e.message))) vaultDenied = true;
    else throw e;
  }
  assert.ok(vaultDenied);
  ok("host_exec denies explicit vault.key path");

  // Sandbox backstop: avoid literal STATE_DIR / state/private in the command
  // text so only Darwin seatbelt (not the string precheck) enforces the deny.
  if (process.platform === "darwin" && fs.existsSync(VAULT_KEY_PATH)) {
    const probe = await runHostExec(agent, {
      cwd: path.dirname(STATE_DIR),
      command:
        'python3 -c \'p=__import__("os").path.join("st"+"ate","pri"+"vate","vault.key"); b=open(p,"rb").read(8); print(b.hex())\'',
      timeoutMs: 10_000,
    });
    const out = `${probe.stdout || ""}${probe.stderr || ""}`;
    assert.ok(
      probe.code !== 0 || /Operation not permitted|Permission denied|Sandbox|No such file/i.test(out),
      `sandbox should block vault.key read; code=${probe.code} out=${out.slice(0, 300)}`,
    );
    const keyHex = fs.readFileSync(VAULT_KEY_PATH).subarray(0, 8).toString("hex");
    assert.ok(
      !out.toLowerCase().includes(keyHex),
      "stdout/stderr must not contain vault.key material",
    );
    ok("Darwin sandbox blocks vault.key read without literal path");
  } else {
    ok("sandbox vault probe skipped (non-Darwin or missing key)");
  }
} catch (e) {
  fail("mediated host run", e);
} finally {
  if (agentId) {
    try {
      removeAgentRecord(agentId);
    } catch {
      /* ignore */
    }
  }
}

done();
