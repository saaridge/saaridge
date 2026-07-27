/**
 * Sample agent: no local FS/network for work — only host-bridge MCP tools.
 * Demonstrates install → MCP proxy → host bridge → host terminal/files/http.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadMcp = () => {
  const mcpPath = path.join(__dirname, "mcp.json");
  if (!fs.existsSync(mcpPath)) {
    throw new Error("mcp.json missing — control plane injects this on install");
  }
  return JSON.parse(fs.readFileSync(mcpPath, "utf8"));
};

const main = async () => {
  const mcp = loadMcp();
  const bridge = mcp.mcpServers["host-bridge"];
  console.log("[sample-agent] connecting to host-bridge via MCP stdio proxy");

  const transport = new StdioClientTransport({
    command: bridge.command,
    args: bridge.args,
    env: { ...process.env, ...bridge.env },
  });

  const client = new Client({ name: "sample-host-agent", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(
    "[sample-agent] tools from bridge:",
    tools.tools.map((t) => t.name).join(", "),
  );

  const ping = await client.callTool({
    name: "terminal_exec",
    arguments: { command: "echo HOST_OK && hostname && pwd" },
  });
  console.log("[sample-agent] terminal_exec =>", JSON.stringify(ping, null, 2));

  // Keep alive so control plane can observe the process
  setInterval(() => {
    console.log("[sample-agent] heartbeat — still bridge-only");
  }, 30_000);
};

main().catch((err) => {
  console.error("[sample-agent] fatal:", err);
  process.exit(1);
});
