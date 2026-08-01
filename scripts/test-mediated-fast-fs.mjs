#!/usr/bin/env node
/**
 * Verify explicit-path exclude exception + tree clamp + memo gen + FS IPC.
 * Uses in-process data API (no Docker). Optional live IPC if BRIDGE_TOKEN set.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const {
  pathHasExcludedComponent,
  isExplicitExcludedAccess,
  isExcludedBasename,
  AGENT_FS_EXCLUDES,
} = await import("../host/bridge/data/agent-fs-excludes.js");
const { list, tree, ensureAgentWorkspace, unlink, health } = await import(
  "../host/bridge/data/api.js"
);
const { workspaceRootFor, removeAgentWorkspace } = await import(
  "../host/bridge/data/paths.js"
);
const { defaultDataPolicy } = await import("../host/bridge/data/policy.js");
const { OPS, startFsBinaryServer } = await import(
  "../host/bridge/data/fs-binary.js"
);
const { createAgentCredential, removeAgentRecord } = await import(
  "../host/lib/auth.js"
);

let failed = 0;
const ok = (name) => console.log(`  OK  ${name}`);
const fail = (name, err) => {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.stack || err}`);
};

console.log("== exclude helpers ==");
try {
  if (!pathHasExcludedComponent("/a/node_modules/b")) throw new Error("nm");
  if (!isExplicitExcludedAccess("/proj/.venv/lib")) throw new Error("venv");
  if (pathHasExcludedComponent("/a/src/index.ts")) throw new Error("clean");
  if (!isExcludedBasename("node_modules")) throw new Error("base");
  if (AGENT_FS_EXCLUDES.length < 40) throw new Error("too few excludes");
  ok("pathHasExcludedComponent / isExplicitExcludedAccess");
} catch (e) {
  fail("helpers", e);
}

const agentId = `fs-fast-${process.pid}`;
const agent = { id: agentId, policy: defaultDataPolicy(agentId) };
let ipcAgentId = null;
await ensureAgentWorkspace(agentId);
const ws = workspaceRootFor(agentId);

const cleanupTestArtifacts = () => {
  if (ipcAgentId) {
    try {
      removeAgentRecord(ipcAgentId);
    } catch {
      /* ignore */
    }
    try {
      removeAgentWorkspace(ipcAgentId);
    } catch {
      /* ignore */
    }
    ipcAgentId = null;
  }
  try {
    removeAgentWorkspace(agentId);
    console.log(`  cleaned workspace ${agentId}`);
  } catch (err) {
    console.warn(`  cleanup warn: ${err?.message || err}`);
  }
};

try {
  console.log("== parent omit + explicit access ==");
  try {
    const nm = path.join(ws, "node_modules", "left-pad");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "index.js"), "module.exports=1;\n");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "app.js"), "console.log(1)\n");
    // Nested excluded under node_modules
    fs.mkdirSync(path.join(ws, "node_modules", ".cache"), { recursive: true });

    const parent = await list(agent, ws, { withStats: true });
    const names = parent.entries.map((e) => e.name);
    if (names.includes("node_modules")) {
      throw new Error("parent listing must omit node_modules");
    }
    if (!names.includes("src")) throw new Error("src missing");
    ok("parent omits node_modules");

    const explicit = await list(agent, path.join(ws, "node_modules"), {
      withStats: true,
    });
    if (!explicit.explicitExcluded) throw new Error("expected explicitExcluded");
    const childNames = explicit.entries.map((e) => e.name);
    if (!childNames.includes("left-pad")) throw new Error("left-pad missing");
    if (childNames.includes(".cache")) {
      throw new Error("nested exclude .cache must still be filtered");
    }
    ok("explicit list(node_modules) shallow + nested filter");

    const deepTree = await tree(agent, path.join(ws, "node_modules"), {
      maxDepth: 4,
      maxEntries: 8000,
    });
    if (deepTree.maxDepth !== 1) {
      throw new Error(`expected depth clamp 1 got ${deepTree.maxDepth}`);
    }
    ok("tree under excluded clamps maxDepth=1");

    const normalTree = await tree(agent, ws, { maxDepth: 4 });
    const rels = (normalTree.entries || []).map((e) => e.rel || e.name);
    if (rels.some((r) => String(r).includes("node_modules"))) {
      throw new Error("normal tree must not descend into node_modules");
    }
    ok("normal tree skips exclude basenames");

    await unlink(agent, path.join(ws, "src", "app.js")).catch(() => {});
  } catch (e) {
    fail("explicit-path", e);
  }

  console.log("== memo caps in health ==");
  try {
    const h = health();
    if (!h.memo || h.memo.bodyMaxTotal == null) throw new Error("no memo stats");
    if (h.memo.bodyMaxTotal < 1024 * 1024) throw new Error("body cap too small");
    if (h.memo.treeMaxBytes == null) throw new Error("no treeMaxBytes");
    ok(`memo stats treeBytes=${h.memo.treeBytes} bodyBytes=${h.memo.bodyBytes}`);
  } catch (e) {
    fail("memo", e);
  }

  console.log("== FS IPC framed protocol ==");
  const ipcPort = 17333 + (process.pid % 1000);
  let ipcServer;
  try {
    // Temporary agent with known token for IPC AUTH
    const cred = createAgentCredential({
      id: `ipc-${process.pid}`,
      name: "ipc-test",
    });
    ipcAgentId = cred.id;
    ipcServer = startFsBinaryServer({ port: ipcPort, host: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 200));

    const encode = (op, reqId, obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const len = 1 + 4 + payload.length;
      const buf = Buffer.alloc(4 + len);
      buf.writeUInt32BE(len, 0);
      buf.writeUInt8(op, 4);
      buf.writeUInt32BE(reqId, 5);
      payload.copy(buf, 9);
      return buf;
    };

    const sock = net.createConnection({ host: "127.0.0.1", port: ipcPort });
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });

    // Simple request/response with leftover buffer
    let leftover = Buffer.alloc(0);
    const rpc = async (op, obj) => {
      sock.write(encode(op, 1, obj));
      let buf = leftover;
      const readMore = () =>
        new Promise((resolve, reject) => {
          sock.once("data", (c) => resolve(c));
          sock.once("error", reject);
        });
      while (buf.length < 4) buf = Buffer.concat([buf, await readMore()]);
      const len = buf.readUInt32BE(0);
      while (buf.length < 4 + len) buf = Buffer.concat([buf, await readMore()]);
      const frame = buf.subarray(4, 4 + len);
      leftover = buf.subarray(4 + len);
      return JSON.parse(frame.subarray(5).toString("utf8") || "{}");
    };

    const auth = await rpc(OPS.AUTH, { token: cred.token });
    if (!auth.ok) throw new Error("AUTH failed");
    ok("IPC AUTH");

    const listed = await rpc(OPS.LIST, {
      path: cred.hostWorkspace,
      withStats: true,
    });
    if (!listed.ok && listed.entries == null) throw new Error(JSON.stringify(listed));
    ok(`IPC LIST entries=${(listed.entries || []).length}`);

    const hl = await rpc(OPS.HEALTH, {});
    if (!hl.ok && hl.memo == null) throw new Error("health");
    ok("IPC HEALTH with memo");

    sock.end();
  } catch (e) {
    fail("fs-ipc", e);
  } finally {
    if (ipcServer?.server) {
      await new Promise((r) => ipcServer.server.close(() => r()));
    }
  }
} finally {
  cleanupTestArtifacts();
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nALL_CHECKS_PASSED");
