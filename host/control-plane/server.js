import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLogs } from "../lib/logger.js";
import { readTraffic } from "../lib/traffic-log.js";
import { getTools, saveTools, listAllTools } from "../lib/state.js";
import {
  installAgentFromHostPath,
  listInstalledAgents,
  uninstallAgent,
} from "./agents.js";
import {
  ensureContainer,
  containerRunning,
  getContainerBootStatus,
} from "../lib/docker.js";
import { listAgentsPublic, getAgentById, getDesktopAgentPublic } from "../lib/auth.js";
import {
  getLlmSettingsPublic,
  saveLlmSettings,
  listProviders,
} from "../lib/llm/index.js";
import { getWorkspaceOs } from "../lib/workspace-os.js";
import {
  listWorkspaceDownloadPackages,
  installAgentFromWorkspaceDownload,
  installAgentFromHostArchive,
  installAgentFromWorkspacePath,
  listWorkspaceInstalledApps,
  uninstallWorkspaceApp,
} from "../lib/workspace-install.js";
import {
  requestOpenInstallAssistant,
  getUiCommands,
  consumeOpenInstallAssistant,
  consumeHostHomeWriteConsentPrompt,
  openInstallAssistantInDesktop,
  resizeDesktopDisplay,
  injectDesktopMouse,
} from "../lib/ui-commands.js";
import { setHostHomeWriteGrant } from "../lib/host-home-grant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const startControlPlane = ({ port = 3847 } = {}) => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Allow the noVNC viewer (different localhost port) to sync desktop size.
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
      /^http:\/\/localhost:\d+$/.test(origin)
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      containerRunning: await containerRunning(),
      agentCount: listAgentsPublic().length,
      proxyPort: Number(process.env.BRIDGE_PROXY_PORT) || 7332,
      workspaceOs: getWorkspaceOs(),
    });
  });

  app.get("/api/workspace/os", (_req, res) => {
    res.json({ ok: true, os: getWorkspaceOs() });
  });

  app.get("/api/container/boot", (_req, res) => {
    res.json({ ok: true, boot: getContainerBootStatus() });
  });

  app.post("/api/container/ensure", async (_req, res) => {
    // Kick off ensure immediately so /api/container/boot reflects progress
    // while this request is still open (desktop app polls in parallel).
    const result = await ensureContainer();
    res.status(result.ok ? 200 : 500).json({
      ...result,
      boot: getContainerBootStatus(),
    });
  });

  app.get("/api/agents", (_req, res) => {
    res.json({
      agents: listInstalledAgents(),
      desktop: getDesktopAgentPublic(),
    });
  });

  app.post("/api/agents/install", async (req, res) => {
    const hostPath = req.body?.hostPath;
    if (!hostPath) {
      return res.status(400).json({ ok: false, error: "hostPath required" });
    }
    const result = await installAgentFromHostPath(hostPath);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/api/agents/downloads", async (_req, res) => {
    const result = await listWorkspaceDownloadPackages();
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/agents/install-from-download", async (req, res) => {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ ok: false, error: "filename required" });
    }
    const result = await installAgentFromWorkspaceDownload(filename);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/agents/install-from-file", async (req, res) => {
    const hostPath = req.body?.hostPath;
    if (!hostPath) {
      return res.status(400).json({ ok: false, error: "hostPath required" });
    }
    const result = await installAgentFromHostArchive(hostPath);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/agents/install-from-workspace-path", async (req, res) => {
    const workspacePath = req.body?.path || req.body?.workspacePath;
    if (!workspacePath) {
      return res.status(400).json({ ok: false, error: "path required" });
    }
    const result = await installAgentFromWorkspacePath(workspacePath);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/api/agents/workspace-apps", async (_req, res) => {
    const result = await listWorkspaceInstalledApps();
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/agents/uninstall-workspace-app", async (req, res) => {
    const packageId = req.body?.package || req.body?.packageId;
    if (!packageId) {
      return res.status(400).json({ ok: false, error: "package required" });
    }
    const result = await uninstallWorkspaceApp(packageId);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/api/ui/commands", (_req, res) => {
    res.json({ ok: true, ...getUiCommands() });
  });

  app.post("/api/ui/open-install", async (_req, res) => {
    const result = await openInstallAssistantInDesktop();
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/ui/resize-desktop", async (req, res) => {
    const width = req.body?.width;
    const height = req.body?.height;
    const result = await resizeDesktopDisplay(width, height);
    res.status(result.ok ? 200 : 500).json(result);
  });

  // Fire-and-forget mouse inject for the Electron/noVNC viewer (xdotool).
  app.post("/api/ui/mouse", async (req, res) => {
    const result = await injectDesktopMouse(req.body || {});
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.post("/api/ui/consume-open-install", (_req, res) => {
    res.json({ ok: true, ...consumeOpenInstallAssistant() });
  });

  app.post("/api/ui/consume-host-home-consent", (_req, res) => {
    res.json({ ok: true, ...consumeHostHomeWriteConsentPrompt() });
  });

  /** Host-user grant: agent may write under host home (~). Never uses container sudo. */
  app.post("/api/agents/:id/host-home-write", (req, res) => {
    try {
      const grant = req.body?.grant !== false && req.body?.grant !== 0;
      if (!getAgentById(req.params.id)) {
        return res.status(404).json({ ok: false, error: "unknown agent" });
      }
      const result = setHostHomeWriteGrant(req.params.id, grant);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/agents/:id/uninstall", async (req, res) => {
    const result = await uninstallAgent(req.params.id);
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/api/tools", (_req, res) => {
    res.json({ tools: listAllTools(), state: getTools() });
  });

  app.post("/api/tools", (req, res) => {
    const { name, description, commandTemplate, cwd, inputSchema } = req.body || {};
    if (!name || !commandTemplate) {
      return res
        .status(400)
        .json({ error: "name and commandTemplate are required" });
    }
    const state = getTools();
    if (
      state.custom.some((t) => t.name === name) ||
      listAllTools().some((t) => t.name === name)
    ) {
      return res.status(409).json({ error: "Tool name already exists" });
    }
    state.custom.push({
      name,
      description: description || `Custom host tool ${name}`,
      commandTemplate,
      cwd,
      inputSchema: inputSchema || {
        type: "object",
        properties: {
          arg: { type: "string", description: "Optional {{arg}} for template" },
        },
      },
    });
    saveTools(state);
    res.json({ ok: true, tools: listAllTools() });
  });

  app.delete("/api/tools/:name", (req, res) => {
    const state = getTools();
    state.custom = state.custom.filter((t) => t.name !== req.params.name);
    saveTools(state);
    res.json({ ok: true, tools: listAllTools() });
  });

  app.get("/api/logs", (req, res) => {
    const name = req.query.name === "bridge" ? "bridge.log" : "control-plane.log";
    res.json({ logs: readLogs(name, Number(req.query.limit) || 200) });
  });

  app.get("/api/traffic", (req, res) => {
    res.json({
      traffic: readTraffic(
        Number(req.query.limit) || 200,
        req.query.agentId || null,
      ),
    });
  });

  app.get("/api/llm/providers", (_req, res) => {
    res.json({ ok: true, providers: listProviders() });
  });

  app.get("/api/llm/settings", (_req, res) => {
    res.json({ ok: true, settings: getLlmSettingsPublic() });
  });

  app.post("/api/llm/settings", (req, res) => {
    const settings = saveLlmSettings({
      apiKey: req.body?.apiKey,
      provider: req.body?.provider,
      model: req.body?.model,
    });
    res.json({ ok: true, settings });
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`[control-plane] http://127.0.0.1:${port}`);
  });

  return app;
};
