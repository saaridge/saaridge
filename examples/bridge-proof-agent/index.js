/**
 * Bridge proof agent — runs INSIDE the locked container.
 * All real work goes through host-bridge MCP (files + HTTP on the Mac).
 *
 * Tests:
 *  1) host_info
 *  2) read_file on Documents/workspace/test/src/hello.js
 *  3) write_file a result note next to that project
 *  4) http_request — simple Google search HTML fetch FROM THE HOST
 *  5) (optional log) remind that raw container curl is blocked
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST_HELLO =
  "/Users/mohitrohatgi/Documents/workspace/test/src/hello.js";
const HOST_RESULT =
  "/Users/mohitrohatgi/Documents/workspace/test/bridge-proof-result.json";
const GOOGLE_URL =
  "https://www.google.com/search?q=Saaridge+agent+gateway&hl=en";

const loadMcp = () => {
  const mcpPath = path.join(__dirname, "mcp.json");
  if (!fs.existsSync(mcpPath)) {
    throw new Error("mcp.json missing — Saaridge injects this on install");
  }
  return JSON.parse(fs.readFileSync(mcpPath, "utf8"));
};

const textOf = (result) => {
  const parts = result?.content || [];
  return parts.map((p) => p.text || "").join("\n");
};

const main = async () => {
  const mcp = loadMcp();
  const bridge = mcp.mcpServers["host-bridge"];
  console.log("[bridge-proof] connecting to host-bridge MCP…");

  const transport = new StdioClientTransport({
    command: bridge.command,
    args: bridge.args,
    env: { ...process.env, ...bridge.env },
  });
  const client = new Client({ name: "bridge-proof-agent", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = (listed.tools || []).map((t) => t.name);
  console.log("[bridge-proof] tools:", names.join(", "));

  const info = await client.callTool({ name: "host_info", arguments: {} });
  console.log("[bridge-proof] host_info =>", textOf(info).slice(0, 400));

  const file = await client.callTool({
    name: "read_file",
    arguments: { path: HOST_HELLO },
  });
  const fileText = textOf(file);
  console.log("[bridge-proof] read_file hello.js =>\n", fileText.slice(0, 500));
  if (!fileText.includes("bridge-test") && !fileText.includes("greet")) {
    throw new Error("Expected host hello.js contents via bridge — got unexpected text");
  }

  const search = await client.callTool({
    name: "http_request",
    arguments: {
      url: GOOGLE_URL,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SaaridgeProof/1.0; +https://localhost)",
        Accept: "text/html",
      },
    },
  });
  const searchText = textOf(search);
  let searchJson;
  try {
    searchJson = JSON.parse(searchText);
  } catch {
    searchJson = { raw: searchText.slice(0, 500) };
  }
  console.log("[bridge-proof] google http_request status =>", searchJson.status);
  console.log(
    "[bridge-proof] google body preview =>",
    String(searchJson.body || "").slice(0, 280).replace(/\s+/g, " "),
  );
  if (!searchJson.status || searchJson.status >= 400) {
    console.warn("[bridge-proof] Google returned non-OK — check host network / proxy");
  }

  const summary = {
    ok: true,
    at: new Date().toISOString(),
    hostFileRead: HOST_HELLO,
    hostFileSnippet: fileText.slice(0, 120),
    googleStatus: searchJson.status ?? null,
    googleVia: searchJson.via || "host",
    tools: names,
  };

  const written = await client.callTool({
    name: "write_file",
    arguments: {
      path: HOST_RESULT,
      content: JSON.stringify(summary, null, 2) + "\n",
    },
  });
  console.log("[bridge-proof] write_file =>", textOf(written));
  console.log("[bridge-proof] SUCCESS — files + Google went through the host bridge");

  setInterval(() => {
    console.log("[bridge-proof] heartbeat — still bridge-only");
  }, 30_000);
};

main().catch((err) => {
  console.error("[bridge-proof] fatal:", err);
  process.exit(1);
});
