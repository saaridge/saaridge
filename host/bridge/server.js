import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveAgentFromRequestHeaders } from "../lib/auth.js";
import { logBridge } from "../lib/logger.js";
import { invokeTool, mcpToolList } from "./tools.js";
import { startProxy } from "./proxy.js";
import { DESKTOP_AGENT_ID } from "../lib/desktop.js";
import {
  listWorkspaceDownloadPackages,
  installAgentFromWorkspaceDownload,
} from "../lib/workspace-install.js";
import { openInstallAssistantInDesktop } from "../lib/ui-commands.js";
import * as dataApi from "./data/api.js";
import { readAudit, auditMetrics } from "./data/audit.js";
import { limitsSnapshot } from "./data/limits.js";
import { startFsBinaryServer } from "./data/fs-binary.js";
import * as vault from "./vault/index.js";
import { vaultFetch } from "./vault/fetch.js";

const FS_VERSION = "1";

const createMcpServer = (agent) => {
  const server = new Server(
    { name: "host-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpToolList(agent),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return invokeTool(request.params.name, request.params.arguments || {}, {
      agent,
    });
  });

  return server;
};

const authAgent = (req, res, next) => {
  const agent = resolveAgentFromRequestHeaders(req.headers);
  if (!agent) {
    logBridge("auth_failed", { ip: req.ip, path: req.path });
    return res.status(401).json({ error: "unauthorized" });
  }
  req.agent = agent;
  return next();
};

const sendFsError = (res, err) => {
  const code = err?.code;
  const status =
    code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? 403
      : code === "ENOENT"
        ? 404
        : code === "EFBIG"
          ? 413
          : code === "EBUSY" || code === "ETIMEDOUT"
            ? 429
            : 500;
  res.setHeader("X-OneBridge-FS", FS_VERSION);
  res.status(status).json({
    ok: false,
    error: err?.message || String(err),
    code: code || "ERROR",
    needHostHomeWrite: Boolean(err?.needHostHomeWrite),
  });
};

const mountFsApi = (app) => {
  app.get("/v1/fs/health", (_req, res) => {
    res.setHeader("X-OneBridge-FS", FS_VERSION);
    res.json({ ...dataApi.health(), limits: limitsSnapshot(), audit: auditMetrics() });
  });

  /** Invalidate ring for FUSE poll — bust local metadata after MCP/agent writes. */
  app.get("/v1/fs/events", authAgent, (req, res) => {
    try {
      const since = req.query.since != null ? Number(req.query.since) : 0;
      const result = dataApi.getFsEvents(since);
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.get("/v1/fs/stat", authAgent, async (req, res) => {
    try {
      const info = await dataApi.stat(req.agent, req.query.path);
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...info });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.get("/v1/fs/list", authAgent, async (req, res) => {
    try {
      // Default shallow: names + types only (no per-file lstat). Clients that
      // need size/mtime call /v1/fs/stat when the user opens that entry.
      // stats=1: lstat immediate children only (still no recursion) — FUSE browse.
      // includeExcluded=1: return community dep/build dirs (lazy explicit open).
      const shallow =
        req.query.shallow !== "0" &&
        req.query.shallow !== "false" &&
        req.query.deep !== "1" &&
        req.query.deep !== "true";
      const withStats =
        req.query.stats === "1" ||
        req.query.stats === "true" ||
        req.query.withStats === "1" ||
        req.query.withStats === "true";
      const includeExcluded =
        req.query.includeExcluded === "1" ||
        req.query.includeExcluded === "true";
      const result = await dataApi.list(req.agent, req.query.path, {
        shallow,
        withStats,
        includeExcluded,
      });
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.get("/v1/fs/tree", authAgent, async (req, res) => {
    try {
      const maxDepth = req.query.maxDepth != null ? Number(req.query.maxDepth) : 6;
      const maxEntries =
        req.query.maxEntries != null ? Number(req.query.maxEntries) : 25000;
      const exclude = req.query.exclude
        ? String(req.query.exclude)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const result = await dataApi.tree(req.agent, req.query.path, {
        maxDepth,
        exclude,
        maxEntries,
      });
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.get("/v1/fs/read", authAgent, async (req, res) => {
    try {
      const offset = req.query.offset != null ? Number(req.query.offset) : 0;
      const length =
        req.query.length != null && req.query.length !== ""
          ? Number(req.query.length)
          : undefined;
      const result = await dataApi.read(req.agent, req.query.path, {
        offset,
        length,
        encoding: "buffer",
      });
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-OneBridge-Bytes", String(result.bytes));
      res.setHeader("X-OneBridge-Path", result.path);
      res.status(200).end(result.data);
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.put(
    "/v1/fs/write",
    authAgent,
    express.raw({ type: "*/*", limit: "52mb" }),
    async (req, res) => {
      try {
        const offset = req.query.offset != null ? Number(req.query.offset) : 0;
        const truncate =
          req.query.truncate === "1" ||
          req.query.truncate === "true" ||
          (offset === 0 && req.query.truncate !== "0");
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await dataApi.write(req.agent, req.query.path, body, {
          offset,
          truncate,
          encoding: "buffer",
        });
        res.setHeader("X-OneBridge-FS", FS_VERSION);
        res.json({ ok: true, ...result });
      } catch (err) {
        sendFsError(res, err);
      }
    },
  );

  app.post("/v1/fs/truncate", authAgent, async (req, res) => {
    try {
      const result = await dataApi.truncate(
        req.agent,
        req.body?.path || req.query.path,
        req.body?.size ?? req.query.size ?? 0,
      );
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.post("/v1/fs/mkdir", authAgent, async (req, res) => {
    try {
      const result = await dataApi.mkdir(
        req.agent,
        req.body?.path || req.query.path,
      );
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.delete("/v1/fs/path", authAgent, async (req, res) => {
    try {
      const result = await dataApi.unlink(
        req.agent,
        req.body?.path || req.query.path,
      );
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.post("/v1/fs/rename", authAgent, async (req, res) => {
    try {
      const result = await dataApi.rename(
        req.agent,
        req.body?.from || req.query.from,
        req.body?.to || req.query.to,
      );
      res.setHeader("X-OneBridge-FS", FS_VERSION);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendFsError(res, err);
    }
  });

  app.get("/v1/fs/roots", authAgent, (req, res) => {
    res.setHeader("X-OneBridge-FS", FS_VERSION);
    res.json({ ok: true, ...dataApi.getRoots(req.agent) });
  });

  app.get("/v1/audit", authAgent, (req, res) => {
    const limit = Number(req.query.limit) || 200;
    const agentId =
      req.query.all === "1" ? null : req.query.agentId || req.agent.id;
    res.json({
      ok: true,
      events: readAudit(limit, agentId),
      metrics: auditMetrics(),
    });
  });

  // Vault — metadata + bridge-owned fetch (secrets never leave the host bridge)
  app.get("/v1/vault", authAgent, (req, res) => {
    res.json({ ok: true, secrets: vault.listMeta(req.agent.id) });
  });

  app.post("/v1/vault/fetch", authAgent, async (req, res) => {
    try {
      const result = await vaultFetch(req.agent, req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      const status =
        err.code === "EACCES" ? 403 : err.code === "ENOENT" ? 404 : 400;
      res.status(status).json({
        ok: false,
        error: err.message || String(err),
        code: err.code,
      });
    }
  });
};

export const startBridge = ({
  port = 7331,
  proxyPort = 7332,
  fsPort = Number(process.env.BRIDGE_FS_PORT || process.env.ONEBRIDGE_FS_PORT || 7333) || 7333,
} = {}) => {
  const app = express();
  // JSON for most routes; /v1/fs/write uses express.raw mounted above.
  app.use((req, res, next) => {
    if (req.method === "PUT" && req.path.startsWith("/v1/fs/write")) {
      return next();
    }
    return express.json({ limit: "10mb" })(req, res, next);
  });

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      service: "host-bridge",
      proxyPort,
      fsPort,
      fs: FS_VERSION,
    }),
  );

  mountFsApi(app);

  app.get("/v1/whoami", authAgent, (req, res) => {
    res.json({
      agentId: req.agent.id,
      name: req.agent.name,
      uid: req.agent.uid,
      roots: dataApi.getRoots(req.agent),
    });
  });

  app.get("/v1/tools", authAgent, (req, res) => {
    res.json({ tools: mcpToolList(req.agent) });
  });

  app.post("/v1/tools/:name/invoke", authAgent, async (req, res) => {
    const result = await invokeTool(req.params.name, req.body?.arguments || {}, {
      agent: req.agent,
    });
    res.json(result);
  });

  app.post("/mcp", authAgent, async (req, res) => {
    const server = createMcpServer(req.agent);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      logBridge("mcp_error", { error: String(error), agentId: req.agent.id });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", authAgent, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  const requireDesktop = (req, res, next) => {
    if (req.agent?.id !== DESKTOP_AGENT_ID && req.agent?.kind !== "desktop") {
      return res.status(403).json({
        ok: false,
        error: "Only the workspace desktop can install from Downloads",
      });
    }
    return next();
  };

  app.get("/v1/workspace/downloads", authAgent, requireDesktop, async (_req, res) => {
    const result = await listWorkspaceDownloadPackages();
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/v1/workspace/install", authAgent, requireDesktop, async (req, res) => {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ ok: false, error: "filename required" });
    }
    logBridge("workspace_install", { filename, agentId: req.agent.id });
    const result = await installAgentFromWorkspaceDownload(filename);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/v1/workspace/open-install", authAgent, requireDesktop, async (_req, res) => {
    const result = await openInstallAssistantInDesktop();
    logBridge("open_install_assistant", {
      ok: result.ok,
      at: result.openInstallAt,
    });
    res.status(result.ok ? 200 : 500).json({
      ...result,
      message: result.ok
        ? "Opening Install Assistant on the desktop…"
        : result.error,
    });
  });

  const server = app.listen(port, "127.0.0.1", () => {
    logBridge("bridge_listening", {
      message: `Host bridge on 127.0.0.1:${port} (per-agent bearer tokens)`,
    });
  });

  const proxy = startProxy({ port: proxyPort });
  const fsIpc = startFsBinaryServer({ port: fsPort });

  return { app, server, proxy, fsIpc, port, proxyPort, fsPort };
};
