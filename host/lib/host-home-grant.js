/**
 * Host-user grant: allow an agent to WRITE under host home (~).
 * Consent is recorded on the host (agent policy); container sudo is never used.
 *
 * States:
 * - hostHomeWrite=true  → RW under ~
 * - declined (skipped)  → RO under ~; auto-prompts suppressed until Allow again
 * - neither             → RO under ~; write attempts queue a consent prompt
 */
import path from "node:path";
import os from "node:os";
import { getAgentById, updateAgentRecord } from "./auth.js";
import { isEphemeralAgentId } from "./ephemeral-agents.js";
import { requestHostHomeWriteConsentPrompt } from "./ui-commands.js";
import { logStep } from "./logger.js";

export const isUnderHostHome = (absPath) => {
  const home = path.resolve(os.homedir());
  const p = path.resolve(String(absPath || ""));
  return p === home || p.startsWith(home + path.sep);
};

export const agentHasHostHomeWrite = (agent) =>
  Boolean(agent?.policy?.hostHomeWrite);

export const agentDeclinedHostHomeWrite = (agent) =>
  Boolean(agent?.policy?.hostHomeWriteDeclinedAt);

/**
 * Persist host-home write grant, revoke, or explicit skip (decline prompts).
 * @param {string} agentId
 * @param {boolean} grant
 * @param {{ skipped?: boolean }} [opts]
 */
export const setHostHomeWriteGrant = (agentId, grant, opts = {}) => {
  const agent = getAgentById(agentId);
  if (!agent) {
    const err = new Error(`Unknown agent: ${agentId}`);
    err.code = "ENOENT";
    throw err;
  }
  const skipped = Boolean(opts.skipped) && !grant;
  const policy = {
    ...(agent.policy || {}),
    hostHomeWrite: Boolean(grant),
    hostHomeWriteAt: Boolean(grant) ? new Date().toISOString() : null,
    hostHomeWriteDeclinedAt: skipped
      ? new Date().toISOString()
      : Boolean(grant)
        ? null
        : agent.policy?.hostHomeWriteDeclinedAt || null,
  };
  if (!grant && !skipped) {
    // Plain revoke — keep prior decline flag if any; do not invent one.
    policy.hostHomeWriteDeclinedAt = agent.policy?.hostHomeWriteDeclinedAt || null;
  }
  const updated = updateAgentRecord(agentId, { policy });
  logStep(
    grant
      ? "Granted host home write"
      : skipped
        ? "Skipped host home write (read-only)"
        : "Revoked host home write",
    { agentId },
  );
  return {
    ok: true,
    agentId,
    hostHomeWrite: Boolean(updated?.policy?.hostHomeWrite),
    hostHomeWriteAt: updated?.policy?.hostHomeWriteAt || null,
    hostHomeWriteDeclinedAt: updated?.policy?.hostHomeWriteDeclinedAt || null,
    skipped,
  };
};

/** Clear decline + queue a fresh consent prompt (re-trigger). */
export const repromptHostHomeWrite = (agentId) => {
  const agent = getAgentById(agentId);
  if (!agent) {
    const err = new Error(`Unknown agent: ${agentId}`);
    err.code = "ENOENT";
    throw err;
  }
  updateAgentRecord(agentId, {
    policy: {
      ...(agent.policy || {}),
      hostHomeWrite: false,
      hostHomeWriteAt: null,
      hostHomeWriteDeclinedAt: null,
    },
  });
  return requestHostHomeWriteConsentPrompt({
    agentId,
    agentName: agent.name || agentId,
    path: "",
  });
};

/** Queue a desktop consent prompt (idempotent while pending). */
export const notifyHostHomeWriteDenied = (agent, deniedPath) => {
  if (!agent?.id) return;
  if (isEphemeralAgentId(agent.id, agent)) return;
  if (agentHasHostHomeWrite(agent)) return;
  // User already chose "Skip anyway" — do not nag until they re-trigger.
  if (agentDeclinedHostHomeWrite(agent)) return;
  requestHostHomeWriteConsentPrompt({
    agentId: agent.id,
    agentName: agent.name || agent.id,
    path: deniedPath || "",
  });
};
