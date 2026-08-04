#!/usr/bin/env node
/**
 * Reliability / data-plane smoke tests (no Docker required for core cases).
 *
 * Covers:
 *  - chunked read/write via data API facade
 *  - deny paths outside ~/OneBridge
 *  - write block globs
 *  - HTTP /v1/fs/* against a live bridge (optional; set BRIDGE_TOKEN)
 *  - FUSE remount hint when container is up
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { ensureAgentWorkspace, read, write, list, unlink, health, getRoots } =
  await import("../host/bridge/data/api.js");
const { oneBridgeRoot, workspaceRootFor, removeAgentWorkspace } = await import(
  "../host/bridge/data/paths.js"
);
const { defaultDataPolicy } = await import("../host/bridge/data/policy.js");

let failed = 0;
const ok = (name) => console.log(`  OK  ${name}`);
const fail = (name, err) => {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.stack || err}`);
};

const agentId = `test-agent-${process.pid}`;
const agent = {
  id: agentId,
  policy: defaultDataPolicy(agentId),
};

const cleanupTestAgent = () => {
  try {
    removeAgentWorkspace(agentId);
    console.log(`  cleaned workspace ${agentId}`);
  } catch (err) {
    console.warn(`  cleanup warn: ${err?.message || err}`);
  }
};

try {
console.log("== data core ==");
try {
  const roots = await ensureAgentWorkspace(agentId);
  if (!fs.existsSync(roots.workspace)) throw new Error("workspace missing");
  ok("ensureAgentWorkspace");
} catch (e) {
  fail("ensureAgentWorkspace", e);
}

try {
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff; // patterned binary (not an encoded-blob lookalike)
  const rel = path.join(workspaceRootFor(agentId), "chunk-test.bin");
  await write(agent, rel, big.subarray(0, 1024 * 1024), {
    offset: 0,
    truncate: true,
  });
  await write(agent, rel, big.subarray(1024 * 1024, 2 * 1024 * 1024), {
    offset: 1024 * 1024,
    truncate: false,
  });
  await write(agent, rel, big.subarray(2 * 1024 * 1024), {
    offset: 2 * 1024 * 1024,
    truncate: false,
  });
  const part = await read(agent, rel, {
    offset: 1024 * 1024,
    length: 64,
    encoding: "buffer",
  });
  if (part.bytes !== 64 || part.data[0] !== ((1024 * 1024) & 0xff)) {
    throw new Error("chunk mismatch");
  }
  const full = await read(agent, rel, { encoding: "buffer" });
  if (full.bytes !== big.length) throw new Error(`size ${full.bytes}`);
  await unlink(agent, rel);
  ok("chunked read/write 3MiB");
} catch (e) {
  fail("chunked read/write", e);
}

try {
  // Under ~ but outside OneBridge: browse-only until hostHomeWrite consent.
  const underHome = path.join(os.homedir(), "NOT-OneBridge-should-deny.txt");
  let homeRo = false;
  try {
    await write(agent, underHome, "x");
  } catch (err) {
    homeRo =
      err.code === "EROFS" ||
      err.needHostHomeWrite === true ||
      /read-only|host home/i.test(err.message);
  }
  if (!homeRo) throw new Error("expected host-home write blocked without consent");
  if (fs.existsSync(underHome)) {
    throw new Error("host-home write must not create the file");
  }
  ok("host-home write blocked without consent");

  // Outside host home entirely: hard deny.
  const outsideHome = path.join(os.tmpdir(), `ob-deny-${process.pid}.txt`);
  let denied = false;
  try {
    await write(agent, outsideHome, "x");
  } catch (err) {
    denied = err.code === "EACCES" || /denied/i.test(err.message);
  }
  if (!denied) throw new Error("expected deny outside host home / OneBridge");
  ok("deny outside host home");
} catch (e) {
  fail("path write policy", e);
}

try {
  const secret = path.join(workspaceRootFor(agentId), ".env");
  let blocked = false;
  try {
    await write(agent, secret, "SECRET=1");
  } catch (err) {
    blocked = err.code === "EACCES" || /blocked/i.test(err.message);
  }
  if (!blocked) throw new Error("expected writeBlockGlobs for .env");
  ok("writeBlockGlobs .env");
} catch (e) {
  fail("writeBlockGlobs", e);
}

try {
  const h = health();
  if (!h.ok || h.version !== 1) throw new Error(JSON.stringify(h));
  const roots = getRoots(agent);
  if (!roots.workspace.includes(agentId)) throw new Error("bad roots");
  await list(agent, roots.workspace);
  ok("health + list");
} catch (e) {
  fail("health + list", e);
}

console.log("== HTTP Data API (optional live bridge) ==");
const token = process.env.BRIDGE_TOKEN || "";
const bridgeUrl = (process.env.BRIDGE_URL || "http://127.0.0.1:7331").replace(
  /\/$/,
  "",
);
if (!token) {
  console.log("  SKIP (set BRIDGE_TOKEN to exercise /v1/fs against a running bridge)");
} else {
  try {
    const healthRes = await fetch(`${bridgeUrl}/v1/fs/health`);
    if (!healthRes.ok) throw new Error(`health ${healthRes.status}`);
    const ver = healthRes.headers.get("x-onebridge-fs");
    if (ver && ver !== "1") throw new Error(`version ${ver}`);
    const ws = `~/OneBridge/workspaces/${agentId}`;
    const put = await fetch(
      `${bridgeUrl}/v1/fs/write?path=${encodeURIComponent(ws + "/http-chunk.txt")}&offset=0&truncate=1`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from("hello-bridge"),
      },
    );
    if (!put.ok) throw new Error(await put.text());
    const get = await fetch(
      `${bridgeUrl}/v1/fs/read?path=${encodeURIComponent(ws + "/http-chunk.txt")}&offset=0&length=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!get.ok) throw new Error(await get.text());
    const buf = Buffer.from(await get.arrayBuffer());
    if (buf.toString() !== "hello") throw new Error(`got ${buf}`);
    ok("HTTP chunk write/read");
  } catch (e) {
    fail("HTTP Data API", e);
  }
}

console.log("== bridge kill / supervisor failover (optional) ==");
if (process.env.TEST_BRIDGE_KILL !== "1") {
  console.log("  SKIP (set TEST_BRIDGE_KILL=1 to SIGKILL bridge pid and expect restart)");
} else {
  try {
    const before = await fetch(`${bridgeUrl}/health`);
    if (!before.ok) throw new Error("bridge not up");
    // Find node process listening on 7331 — best-effort via lsof
    const lsof = spawn("lsof", ["-t", "-iTCP:7331", "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pidOut = "";
    for await (const c of lsof.stdout) pidOut += c;
    const pid = Number(pidOut.trim().split("\n")[0]);
    if (!pid) throw new Error("no listener on 7331");
    process.kill(pid, "SIGKILL");
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const h = await fetch(`${bridgeUrl}/v1/fs/health`);
        if (h.ok) {
          recovered = true;
          break;
        }
      } catch {
        /* wait */
      }
    }
    if (!recovered) throw new Error("bridge did not recover");
    ok("bridge kill + recover");
  } catch (e) {
    fail("bridge kill/failover", e);
  }
}

console.log("== FUSE remount (optional docker) ==");
if (process.env.TEST_FUSE !== "1") {
  console.log("  SKIP (set TEST_FUSE=1 with running agent-bridge-box)");
} else {
  try {
    const { run } = await import("../host/lib/docker.js");
    const check = await run("docker", [
      "exec",
      "agent-bridge-box",
      "bash",
      "-lc",
      "findmnt -T /host | head -1; ls /host/workspaces >/dev/null && echo MOUNTED",
    ]);
    if (!/MOUNTED/.test(check.stdout || "")) {
      throw new Error(check.stdout || check.stderr || "not mounted");
    }
    await run("docker", [
      "exec",
      "agent-bridge-box",
      "bash",
      "-lc",
      "pkill -f hostfs-fuse.py || true",
    ]);
    let remounted = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const again = await run("docker", [
        "exec",
        "agent-bridge-box",
        "bash",
        "-lc",
        "ls /host/workspaces >/dev/null 2>&1 && echo OK || echo NO",
      ]);
      if (/OK/.test(again.stdout || "")) {
        remounted = true;
        break;
      }
    }
    if (!remounted) throw new Error("FUSE did not remount");
    ok("FUSE remount via watchdog");
  } catch (e) {
    fail("FUSE remount", e);
  }
}
} finally {
  cleanupTestAgent();
}

console.log(`\nDone. root=${oneBridgeRoot()} failures=${failed}`);
process.exit(failed ? 1 : 0);
