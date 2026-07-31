/**
 * Host-user grant: allow an agent to WRITE under host home (~).
 * Consent is recorded on the host (agent policy); container sudo is never used.
 */
import path from "node:path";
import os from "node:os";
import { getAgentById, updateAgentRecord } from "./auth.js";
import { requestHostHomeWriteConsentPrompt } from "./ui-commands.js";
import { logStep } from "./logger.js";

export const isUnderHostHome = (absPath) => {
  const home = path.resolve(os.homedir());
  const p = path.resolve(String(absPath || ""));
  return p === home || p.startsWith(home + path.sep);
};

export const agentHasHostHomeWrite = (agent) =>
  Boolean(agent?.policy?.hostHomeWrite);

/**
 * Persist host-home write grant (or revoke) on the agent policy.
 * @param {string} agentId
 * @param {boolean} grant
 */
export const setHostHomeWriteGrant = (agentId, grant) => {
  const agent = getAgentById(agentId);
  if (!agent) {
    const err = new Error(`Unknown agent: ${agentId}`);
    err.code = "ENOENT";
    throw err;
  }
  const policy = {
    ...(agent.policy || {}),
    hostHomeWrite: Boolean(grant),
    hostHomeWriteAt: Boolean(grant) ? new Date().toISOString() : null,
  };
  const updated = updateAgentRecord(agentId, { policy });
  logStep(grant ? "Granted host home write" : "Revoked host home write", {
    agentId,
  });
  return {
    ok: true,
    agentId,
    hostHomeWrite: Boolean(updated?.policy?.hostHomeWrite),
    hostHomeWriteAt: updated?.policy?.hostHomeWriteAt || null,
  };
};

/** Queue a desktop consent prompt (idempotent while pending). */
export const notifyHostHomeWriteDenied = (agent, deniedPath) => {
  if (!agent?.id) return;
  if (agentHasHostHomeWrite(agent)) return;
  requestHostHomeWriteConsentPrompt({
    agentId: agent.id,
    agentName: agent.name || agent.id,
    path: deniedPath || "",
  });
};
