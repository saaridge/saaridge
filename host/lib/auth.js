import crypto from "node:crypto";
import { getAgents, saveAgents } from "./state.js";

const NEXT_UID_START = 12000;

export const createAgentCredential = ({ id, name }) => {
  const state = getAgents();
  const usedUids = new Set((state.agents || []).map((a) => a.uid));
  let uid = state.nextUid || NEXT_UID_START;
  while (usedUids.has(uid)) uid += 1;
  state.nextUid = uid + 1;

  const token = crypto.randomBytes(32).toString("hex");
  const username = `u${uid}`;
  const record = {
    id,
    name,
    uid,
    username,
    token,
    localProxyPort: 18000 + (uid % 1000),
    policy: {
      // Passthrough for now — hooks for later allow/deny.
      allowAllProxy: true,
      tools: null, // null = all tools
      paths: null,
      urls: null,
    },
    installedAt: new Date().toISOString(),
    status: "installing",
  };

  state.agents = state.agents || [];
  state.agents.push(record);
  saveAgents(state);
  return record;
};

export const updateAgentRecord = (agentId, patch) => {
  const state = getAgents();
  const idx = state.agents.findIndex((a) => a.id === agentId);
  if (idx < 0) return null;
  state.agents[idx] = { ...state.agents[idx], ...patch };
  saveAgents(state);
  return state.agents[idx];
};

export const removeAgentRecord = (agentId) => {
  const state = getAgents();
  state.agents = (state.agents || []).filter((a) => a.id !== agentId);
  saveAgents(state);
};

export const resolveAgentByToken = (token) => {
  if (!token) return null;
  const state = getAgents();
  return (state.agents || []).find((a) => a.token === token) || null;
};

export const getAgentById = (agentId) => {
  const state = getAgents();
  return (state.agents || []).find((a) => a.id === agentId) || null;
};

/** Public agent list without secrets (excludes internal desktop identity from assistants UI) */
export const listAgentsPublic = () =>
  (getAgents().agents || [])
    .filter((a) => a.id !== "workspace-desktop" && a.kind !== "desktop")
    .map((a) => ({
      id: a.id,
      name: a.name,
      uid: a.uid,
      username: a.username,
      containerPath: a.containerPath,
      hostPath: a.hostPath,
      status: a.status,
      installedAt: a.installedAt,
      localProxyPort: a.localProxyPort,
      tokenFingerprint: a.token ? a.token.slice(0, 8) : null,
    }));

export const parseBearer = (header = "") => {
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return "";
};

export const parseProxyBasicAuth = (header = "") => {
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return { username: decoded, password: "" };
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
};

/**
 * Resolve agent from HTTP Authorization or Proxy-Authorization.
 * Identity is ALWAYS derived from the token secret — username/agentId in the
 * request cannot elevate privileges.
 */
export const resolveAgentFromRequestHeaders = (headers) => {
  const bearer = parseBearer(headers.authorization || "");
  if (bearer) {
    return resolveAgentByToken(bearer);
  }
  const basic = parseProxyBasicAuth(
    headers["proxy-authorization"] || headers["Proxy-Authorization"] || "",
  );
  if (basic?.password) {
    const agent = resolveAgentByToken(basic.password);
    if (agent) return agent;
  }
  if (basic?.username && basic.username.length > 20) {
    // Allow token-as-username forms
    return resolveAgentByToken(basic.username);
  }
  return null;
};
