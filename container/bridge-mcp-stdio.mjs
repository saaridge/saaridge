#!/usr/bin/env node
/**
 * MCP stdio proxy inside the container.
 * Loads per-agent token from a UID-private credentials file (never trusts body agentId).
 */
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const loadCreds = () => {
  const file = process.env.BRIDGE_CREDENTIALS_FILE;
  if (file && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (process.env.BRIDGE_TOKEN) {
    return {
      token: process.env.BRIDGE_TOKEN,
      agentId: process.env.AGENT_ID || "unknown",
      bridgeUrl: process.env.BRIDGE_URL,
    };
  }
  throw new Error("Missing BRIDGE_CREDENTIALS_FILE / BRIDGE_TOKEN");
};

const creds = loadCreds();
const BRIDGE_URL = (
  creds.bridgeUrl ||
  process.env.BRIDGE_URL ||
  "http://host.docker.internal:7331"
).replace(/\/$/, "");
const BRIDGE_TOKEN = creds.token;

const bridgeFetch = async (path, options = {}) => {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge ${res.status}: ${text}`);
  }
  return res.json();
};

const server = new Server(
  { name: "host-bridge-proxy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const data = await bridgeFetch("/v1/tools");
  return { tools: data.tools || [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Do not send agentId — host derives identity solely from bearer token.
  return bridgeFetch(`/v1/tools/${encodeURIComponent(request.params.name)}/invoke`, {
    method: "POST",
    body: JSON.stringify({
      arguments: request.params.arguments || {},
    }),
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
