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
import {
  listPolicyAlgorithms,
  listPolicyAgents,
  getPolicyAgent,
  ensurePolicyAgent,
  enablePolicy,
  disablePolicy,
  setPolicyOverride,
  listGlobalPolicies,
  setGlobalPolicy,
  setPolicyMode,
  setPolicyCategories,
  setPolicyKnownValues,
  listPolicyCatalog,
  policyStatus,
  AI_POLICY_CONFIG_PATH,
} from "../lib/ai-policy.js";

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
      aiPolicy: policyStatus(),
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

  app.get("/api/desktop/stream-health", async (_req, res) => {
    const { getStreamHealth } = await import("../lib/stream-stack.js");
    const health = await getStreamHealth();
    res.status(health.ok ? 200 : 503).json({ ok: health.ok, health });
  });

  app.post("/api/desktop/ensure-stream", async (req, res) => {
    const { ensureStreamStack } = await import("../lib/stream-stack.js");
    const force = Boolean(req.body?.force);
    const result = await ensureStreamStack({ force });
    res.status(result.ok ? 200 : 500).json(result);
  });

  /**
   * Mediate host pasteboard text before it enters the container (agent-visible).
   * Fail-closed: deny/error → empty text.
   */
  app.post("/api/desktop/mediate-clipboard", async (req, res) => {
    const raw = req.body?.text == null ? "" : String(req.body.text);
    const desktopPub = getDesktopAgentPublic();
    const desktop =
      getAgentById("workspace-desktop") ||
      (desktopPub?.id ? getAgentById(desktopPub.id) : null) ||
      { id: "workspace-desktop" };
    try {
      const { onClipboardIngress } = await import("../bridge/control/index.js");
      const result = await onClipboardIngress({ agent: desktop, text: raw });
      if (result?.action === "deny") {
        return res.json({
          ok: true,
          text: "",
          denied: true,
          reason: result.reason || "denied",
        });
      }
      return res.json({
        ok: true,
        text: result?.text == null ? "" : String(result.text),
        denied: false,
        action: result?.action || "allow",
      });
    } catch (err) {
      return res.json({
        ok: true,
        text: "",
        denied: true,
        reason: err?.message || "clipboard_mediate_error",
      });
    }
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

  // --- AI policy admin (host-only; store under state/private) ---
  app.get("/api/policies/status", (_req, res) => {
    res.json({ ok: true, ...policyStatus(), configPath: AI_POLICY_CONFIG_PATH });
  });

  app.get("/api/policies/global", (_req, res) => {
    try {
      res.json({ ok: true, algorithms: listGlobalPolicies() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/global", (req, res) => {
    try {
      const algorithmId = String(req.body?.algorithmId || "");
      const enabled = req.body?.enabled !== false && req.body?.enabled !== 0;
      if (!algorithmId) {
        return res.status(400).json({ ok: false, error: "algorithmId required" });
      }
      const algorithms = setGlobalPolicy(algorithmId, enabled);
      res.json({ ok: true, algorithms });
    } catch (err) {
      const status = err?.code === "UNKNOWN_ALGORITHM" ? 404 : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/mode", (req, res) => {
    try {
      const algorithmId = String(req.body?.algorithmId || "");
      const mode = String(req.body?.mode || "");
      if (!algorithmId || !mode) {
        return res
          .status(400)
          .json({ ok: false, error: "algorithmId and mode required" });
      }
      const algorithms = setPolicyMode(algorithmId, mode);
      res.json({ ok: true, algorithms });
    } catch (err) {
      const status =
        err?.code === "UNKNOWN_ALGORITHM"
          ? 404
          : err?.code === "INVALID_MODE"
            ? 400
            : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/categories", (req, res) => {
    try {
      const algorithmId = String(req.body?.algorithmId || "");
      const categories = req.body?.categories;
      if (!algorithmId || !categories || typeof categories !== "object") {
        return res.status(400).json({
          ok: false,
          error: "algorithmId and categories object required",
        });
      }
      const algorithms = setPolicyCategories(algorithmId, categories);
      res.json({ ok: true, algorithms });
    } catch (err) {
      const status = err?.code === "UNKNOWN_ALGORITHM" ? 404 : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/known-values", (req, res) => {
    try {
      const algorithmId = String(req.body?.algorithmId || "words-i-protect");
      const values = req.body?.values;
      if (!Array.isArray(values)) {
        return res
          .status(400)
          .json({ ok: false, error: "values array required" });
      }
      const algorithms = setPolicyKnownValues(algorithmId, values);
      res.json({ ok: true, algorithms });
    } catch (err) {
      const status =
        err?.code === "UNSUPPORTED"
          ? 400
          : err?.code === "UNKNOWN_ALGORITHM"
            ? 404
            : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/policies/catalog", (_req, res) => {
    try {
      res.json({ ok: true, policies: listPolicyCatalog() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/policies/algorithms", (_req, res) => {
    try {
      res.json({ ok: true, algorithms: listPolicyAlgorithms() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/policies/agents", (_req, res) => {
    try {
      // Merge OneBridge agents + desktop + any bindings already in the store
      const known = new Map();
      for (const a of listInstalledAgents()) {
        known.set(a.id, { agentId: a.id, name: a.name || a.id, kind: "assistant" });
      }
      const desktop = getDesktopAgentPublic();
      if (desktop?.id) {
        known.set(desktop.id, {
          agentId: desktop.id,
          name: desktop.name || "Workspace Desktop",
          kind: "desktop",
        });
      }
      const bindings = listPolicyAgents();
      for (const b of bindings) {
        if (!known.has(b.agentId)) {
          known.set(b.agentId, {
            agentId: b.agentId,
            name: b.agentId,
            kind: "configured",
          });
        }
      }
      const agents = [...known.values()].map((meta) => {
        const binding = getPolicyAgent(meta.agentId);
        return {
          ...meta,
          activeAlgorithms: binding.activeAlgorithms || [],
          configuredAlgorithms: binding.configured?.activeAlgorithms || [],
          overrides: binding.configured?.overrides || {},
          algorithms: binding.algorithms || [],
        };
      });
      res.json({ ok: true, agents });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/policies/agents/:id", (req, res) => {
    try {
      res.json({ ok: true, ...getPolicyAgent(req.params.id) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/agents/ensure", (req, res) => {
    try {
      const agentId = String(req.body?.agentId || "");
      if (!agentId) {
        return res.status(400).json({ ok: false, error: "agentId required" });
      }
      res.json({ ok: true, ...ensurePolicyAgent(agentId) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/bindings/enable", (req, res) => {
    try {
      const agentId = String(req.body?.agentId || "");
      const algorithmId = String(req.body?.algorithmId || "");
      if (!agentId || !algorithmId) {
        return res
          .status(400)
          .json({ ok: false, error: "agentId and algorithmId required" });
      }
      const binding = enablePolicy(agentId, algorithmId);
      res.json({ ok: true, ...binding });
    } catch (err) {
      const status = err?.code === "UNKNOWN_ALGORITHM" ? 404 : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/bindings/disable", (req, res) => {
    try {
      const agentId = String(req.body?.agentId || "");
      const algorithmId = String(req.body?.algorithmId || "");
      if (!agentId || !algorithmId) {
        return res
          .status(400)
          .json({ ok: false, error: "agentId and algorithmId required" });
      }
      const binding = disablePolicy(agentId, algorithmId);
      res.json({ ok: true, ...binding });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/policies/bindings/override", (req, res) => {
    try {
      const agentId = String(req.body?.agentId || "");
      const algorithmId = String(req.body?.algorithmId || "");
      const mode = String(req.body?.mode || "");
      if (!agentId || !algorithmId) {
        return res
          .status(400)
          .json({ ok: false, error: "agentId and algorithmId required" });
      }
      if (mode !== "follow" && mode !== "on" && mode !== "off") {
        return res
          .status(400)
          .json({ ok: false, error: "mode must be follow|on|off" });
      }
      const binding = setPolicyOverride(agentId, algorithmId, mode);
      res.json({ ok: true, ...binding });
    } catch (err) {
      const status = err?.code === "UNKNOWN_ALGORITHM" ? 404 : 500;
      res.status(status).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`[control-plane] http://127.0.0.1:${port}`);
  });

  return app;
};
