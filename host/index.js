import { startBridge } from "./bridge/server.js";
import { startControlPlane } from "./control-plane/server.js";
import { purgeEphemeralAgents } from "./lib/ephemeral-agents.js";
import { logError, logStep } from "./lib/logger.js";

/**
 * Packaged host runs as Electron-as-Node. An uncaught throw otherwise pops
 * Electron's "A JavaScript error occurred in the main process" dialog.
 */
process.on("uncaughtException", (err) => {
  logError("Host uncaughtException", {
    detail: String(err?.stack || err?.message || err),
  });
});
process.on("unhandledRejection", (reason) => {
  logError("Host unhandledRejection", {
    detail: String(reason?.stack || reason?.message || reason),
  });
});

const { removedIds } = purgeEphemeralAgents();
if (removedIds.length) {
  logStep("Purged ephemeral test agents", {
    count: removedIds.length,
    ids: removedIds,
  });
}

logStep("Starting host control plane + bridge", {
  note: "Per-agent tokens; MCP :7331; passthrough proxy :7332; FS IPC :7333",
});

const bridge = startBridge({
  port: Number(process.env.BRIDGE_PORT) || 7331,
  proxyPort: Number(process.env.BRIDGE_PROXY_PORT) || 7332,
  fsPort: Number(process.env.BRIDGE_FS_PORT || process.env.SAARIDGE_FS_PORT) || 7333,
});
startControlPlane({ port: Number(process.env.CONTROL_PORT) || 3847 });

console.log(`
Saaridge (alpha ${process.env.npm_package_version || "0.0.1"})
----------------------
Control UI     : http://127.0.0.1:3847
Desktop app    : npm run app   (native window; no URL bar)
Bridge MCP/API : http://127.0.0.1:${bridge.port}
Bridge Proxy   : http://127.0.0.1:${bridge.proxyPort} (passthrough; proxy-auth = agent token)
FS IPC         : 127.0.0.1:${bridge.fsPort} (framed binary; FUSE preferred path)
Container UI   : http://127.0.0.1:6081/novnc-saaridge.html
Auth model     : per-agent bearer tokens (no shared bridge.token for agents)
Bridge LLM     : optional — createLlmClient() / API key in desktop app (env or memory only)
`);
