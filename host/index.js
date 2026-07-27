import { startBridge } from "./bridge/server.js";
import { startControlPlane } from "./control-plane/server.js";
import { logStep } from "./lib/logger.js";

logStep("Starting host control plane + bridge", {
  note: "Per-agent tokens; MCP :7331; passthrough proxy :7332",
});

const bridge = startBridge({
  port: Number(process.env.BRIDGE_PORT) || 7331,
  proxyPort: Number(process.env.BRIDGE_PROXY_PORT) || 7332,
});
startControlPlane({ port: Number(process.env.CONTROL_PORT) || 3847 });

console.log(`
Agent Bridge Prototype
----------------------
Control UI     : http://127.0.0.1:3847
Desktop app    : npm run app   (native window; no URL bar)
Bridge MCP/API : http://127.0.0.1:${bridge.port}
Bridge Proxy   : http://127.0.0.1:${bridge.proxyPort} (passthrough; proxy-auth = agent token)
Container UI   : http://127.0.0.1:6081/novnc-onebridge.html
Auth model     : per-agent bearer tokens (no shared bridge.token for agents)
Bridge LLM     : optional — createLlmClient() / API key in desktop app (env or memory only)
`);
