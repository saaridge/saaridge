import fs from "node:fs";
import path from "node:path";
import { removeAgentWorkspace } from "../bridge/data/paths.js";
import { getAgents, saveAgents } from "./state.js";
import { STATE_DIR } from "./paths.js";

const UI_FILE = path.join(STATE_DIR, "ui-commands.json");

const EPHEMERAL_PREFIXES = [
  "proxy-stream-",
  "mediate-test-",
  "test-agent-",
  "fs-fast-",
  "ipc-",
  "sample-host-agent-",
];

const EPHEMERAL_NAME_PREFIXES = ["fail-setup-demo", "silent-setup-demo"];

/**
 * True for test / harness agent ids. Never treats workspace-desktop or
 * kind === "desktop" agents as ephemeral.
 */
export const isEphemeralAgentId = (id, agent = null) => {
  if (!id) return false;
  if (id === "workspace-desktop") return false;
  if (agent?.kind === "desktop") return false;
  const s = String(id);
  if (EPHEMERAL_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (EPHEMERAL_NAME_PREFIXES.some((p) => s.startsWith(p))) return true;
  return false;
};

const readUi = () => {
  try {
    if (!fs.existsSync(UI_FILE)) {
      return { openInstallAt: null, hostHomeWriteConsent: null };
    }
    return {
      openInstallAt: null,
      hostHomeWriteConsent: null,
      ...JSON.parse(fs.readFileSync(UI_FILE, "utf8")),
    };
  } catch {
    return { openInstallAt: null, hostHomeWriteConsent: null };
  }
};

const writeUi = (data) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(UI_FILE, JSON.stringify(data, null, 2));
};

/** Drop stale desktop UI commands (test consent prompts, unconsumed install flags). */
export const purgeStaleUiCommands = () => {
  const data = readUi();
  const agentIds = new Set((getAgents().agents || []).map((a) => a.id));
  let dirty = false;

  const consent = data.hostHomeWriteConsent;
  if (consent?.agentId) {
    if (
      isEphemeralAgentId(consent.agentId) ||
      !agentIds.has(consent.agentId)
    ) {
      data.hostHomeWriteConsent = null;
      dirty = true;
    }
  }

  if (data.openInstallAt) {
    data.openInstallAt = null;
    dirty = true;
  }

  if (dirty) writeUi(data);
  return dirty;
};

/**
 * Remove ephemeral agents from agents.json, delete host workspaces, and
 * purge stale UI commands.
 */
export const purgeEphemeralAgents = ({ dryRun = false } = {}) => {
  const state = getAgents();
  const agents = state.agents || [];
  const toRemove = agents.filter((a) => isEphemeralAgentId(a.id, a));
  const removedIds = toRemove.map((a) => a.id);

  if (!dryRun) {
    if (removedIds.length) {
      state.agents = agents.filter((a) => !isEphemeralAgentId(a.id, a));
      saveAgents(state);
      for (const id of removedIds) {
        try {
          removeAgentWorkspace(id);
        } catch {
          /* workspace may already be gone */
        }
      }
    }
    purgeStaleUiCommands();
  }

  return { removedIds, dryRun };
};
