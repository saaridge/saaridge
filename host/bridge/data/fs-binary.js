/**
 * Framed binary FS protocol over TCP (default 127.0.0.1:7333).
 *
 * Note: host MITM proxy already owns :7332 — FS IPC uses :7333
 * (BRIDGE_FS_PORT / SAARIDGE_FS_PORT).
 *
 * Frame: u32 BE length | u8 op | u32 BE reqId | payload
 * Length = 1 + 4 + payload.length (bytes after the length field).
 * Payload = UTF-8 JSON object (binary-friendly framing; same ops as HTTP /v1/fs/*).
 *
 * All ops call data/api.js so control/policy stay one path. HTTP remains for MCP.
 */
import net from "node:net";
import { resolveAgentByToken } from "../../lib/auth.js";
import { logBridge } from "../../lib/logger.js";
import * as dataApi from "./api.js";

/** Negative lookups an editor makes constantly — answered, never logged. */
export const EXPECTED_FS_CODES = new Set(["ENOENT", "ENOTDIR"]);

export const OPS = Object.freeze({
  AUTH: 1,
  TREE: 2,
  LIST: 3,
  STAT: 4,
  READ: 5,
  WRITE: 6,
  MKDIR: 7,
  UNLINK: 8,
  RENAME: 9,
  TRUNCATE: 10,
  EVENTS: 11,
  HEALTH: 12,
  ERROR: 255,
});

const OP_NAME = Object.fromEntries(
  Object.entries(OPS).map(([k, v]) => [v, k]),
);

const DEFAULT_PORT = Number(process.env.BRIDGE_FS_PORT || process.env.SAARIDGE_FS_PORT || 7333) || 7333;

const encodeFrame = (op, reqId, payloadObj) => {
  const payload = Buffer.from(JSON.stringify(payloadObj ?? {}), "utf8");
  const len = 1 + 4 + payload.length;
  const buf = Buffer.allocUnsafe(4 + len);
  buf.writeUInt32BE(len, 0);
  buf.writeUInt8(op & 0xff, 4);
  buf.writeUInt32BE(reqId >>> 0, 5);
  payload.copy(buf, 9);
  return buf;
};

const encodeError = (reqId, err, op = OPS.ERROR) =>
  encodeFrame(op, reqId, {
    ok: false,
    error: err?.message || String(err),
    code: err?.code || "EIO",
    status: err?.status || 500,
  });

/**
 * Handle one decoded request. Returns response payload object + optional raw body
 * for READ (attached as base64 in JSON for simplicity).
 */
const handleOp = async (agent, op, body) => {
  switch (op) {
    case OPS.HEALTH:
      return { ok: true, ...dataApi.health(), ipc: true };
    case OPS.EVENTS: {
      const since = body?.since != null ? Number(body.since) : 0;
      return { ok: true, ...dataApi.getFsEvents(since) };
    }
    case OPS.STAT: {
      const info = await dataApi.stat(agent, body?.path);
      return {
        ok: true,
        ...info,
        // Gen fields for FUSE memo (mtimeMs + size).
        gen: `${Number(info.mtimeMs) || 0}:${Number(info.size) || 0}`,
      };
    }
    case OPS.LIST: {
      const result = await dataApi.list(agent, body?.path, {
        shallow: body?.shallow !== false,
        withStats: body?.withStats !== false && body?.stats !== false,
        includeExcluded: !!body?.includeExcluded,
      });
      return { ok: true, ...result };
    }
    case OPS.TREE: {
      const result = await dataApi.tree(agent, body?.path, {
        maxDepth: body?.maxDepth != null ? Number(body.maxDepth) : 4,
        maxEntries: body?.maxEntries != null ? Number(body.maxEntries) : 8000,
        exclude: body?.exclude,
      });
      return { ok: true, ...result };
    }
    case OPS.READ: {
      const result = await dataApi.read(agent, body?.path, {
        offset: body?.offset != null ? Number(body.offset) : 0,
        length:
          body?.length != null && body.length !== ""
            ? Number(body.length)
            : undefined,
        encoding: "buffer",
      });
      const buf = Buffer.isBuffer(result.data)
        ? result.data
        : Buffer.from(result.data || "");
      return {
        ok: true,
        path: result.path,
        bytes: result.bytes,
        offset: body?.offset != null ? Number(body.offset) : 0,
        encoding: "base64",
        data: buf.toString("base64"),
      };
    }
    case OPS.WRITE: {
      const raw =
        body?.encoding === "base64"
          ? Buffer.from(body?.data || "", "base64")
          : Buffer.from(body?.data || "", "utf8");
      const result = await dataApi.write(agent, body?.path, raw, {
        offset: body?.offset != null ? Number(body.offset) : 0,
        truncate: body?.truncate !== false && body?.truncate !== 0,
      });
      return { ok: true, ...result };
    }
    case OPS.MKDIR: {
      const result = await dataApi.mkdir(agent, body?.path);
      return { ok: true, ...result };
    }
    case OPS.UNLINK: {
      const result = await dataApi.unlink(agent, body?.path);
      return { ok: true, ...result };
    }
    case OPS.RENAME: {
      const result = await dataApi.rename(agent, body?.from, body?.to);
      return { ok: true, ...result };
    }
    case OPS.TRUNCATE: {
      const result = await dataApi.truncate(
        agent,
        body?.path,
        body?.size != null ? Number(body.size) : 0,
      );
      return { ok: true, ...result };
    }
    default: {
      const err = new Error(`unknown op ${op}`);
      err.code = "EINVAL";
      throw err;
    }
  }
};

const attachConnection = (socket) => {
  let agent = null;
  let buf = Buffer.alloc(0);
  let closed = false;
  let chain = Promise.resolve();

  const send = (op, reqId, payload) => {
    if (closed || socket.destroyed) return;
    try {
      socket.write(encodeFrame(op, reqId, payload));
    } catch {
      /* ignore */
    }
  };

  socket.setNoDelay(true);
  socket.on("error", () => {
    closed = true;
  });
  socket.on("close", () => {
    closed = true;
  });

  const processFrames = async () => {
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len < 5 || len > 64 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (buf.length < 4 + len) return;
      const frame = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      const op = frame.readUInt8(0);
      const reqId = frame.readUInt32BE(1);
      let body = {};
      try {
        const raw = frame.subarray(5).toString("utf8");
        body = raw ? JSON.parse(raw) : {};
      } catch {
        send(OPS.ERROR, reqId, {
          ok: false,
          error: "invalid json payload",
          code: "EINVAL",
        });
        continue;
      }

      try {
        if (op === OPS.AUTH) {
          const token = String(body?.token || "").trim();
          const resolved = resolveAgentByToken(token);
          if (!resolved) {
            send(OPS.AUTH, reqId, {
              ok: false,
              error: "unauthorized",
              code: "EAUTH",
            });
            socket.end();
            return;
          }
          agent = resolved;
          send(OPS.AUTH, reqId, {
            ok: true,
            agentId: agent.id,
            name: agent.name,
          });
          continue;
        }

        if (op === OPS.HEALTH && !agent) {
          send(OPS.HEALTH, reqId, {
            ok: true,
            ...dataApi.health(),
            ipc: true,
            authed: false,
          });
          continue;
        }

        if (!agent) {
          send(OPS.ERROR, reqId, {
            ok: false,
            error: "AUTH required",
            code: "EAUTH",
          });
          continue;
        }

        const result = await handleOp(agent, op, body);
        send(op, reqId, result);
      } catch (err) {
        // A missing path is the normal answer to a probe, not a fault: editors
        // stat .cursor/.vscode/.config on every keystroke. Logging those made
        // ENOENT ~69% of bridge.log (24MB) and put a synchronous append on the
        // hot FS path. The client still gets the error reply.
        if (!EXPECTED_FS_CODES.has(err?.code)) {
          logBridge("fs_ipc_op_error", {
            op: OP_NAME[op] || op,
            error: err?.message || String(err),
            code: err?.code,
          });
        }
        socket.write(encodeError(reqId, err, OPS.ERROR));
      }
    }
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    chain = chain.then(processFrames).catch(() => {});
  });
};

/**
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {{ server: import('node:net').Server, port: number, host: string }}
 */
export const startFsBinaryServer = ({
  port = DEFAULT_PORT,
  host = "127.0.0.1",
} = {}) => {
  const server = net.createServer({ allowHalfOpen: false }, attachConnection);
  server.listen(port, host, () => {
    logBridge("fs_ipc_listening", {
      message: `Host FS IPC on ${host}:${port} (framed JSON; AUTH then TREE/LIST/…)`,
      port,
      host,
    });
  });
  server.on("error", (err) => {
    logBridge("fs_ipc_error", { error: err?.message || String(err), port });
    console.error(`[fs-ipc] listen failed on :${port}:`, err?.message || err);
    process.exit(1);
  });
  return { server, port, host };
};

export const fsIpcDefaultPort = () => DEFAULT_PORT;
