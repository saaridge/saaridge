/**
 * Saaridge LLM library — select a provider + model + API key for bridge use.
 *
 * Keys are never written to disk (env or in-memory runtime only).
 *
 * Usage:
 *   import { createLlmClient, listProviders, saveLlmSettings } from "../lib/llm/index.js";
 *   const llm = createLlmClient({ provider: "gemini", apiKey, model });
 *   const out = await llm.complete({ messages: [{ role: "user", content: "hi" }] });
 */
import { listProviders, PROVIDERS } from "./providers.js";
import {
  getLlmSettingsPublic,
  saveLlmSettings,
  setRuntimeLlmKey,
  clearRuntimeLlmKey,
  resolveLlmConfig,
} from "./settings.js";
import { complete } from "./complete.js";

/**
 * Create a client bound to a provider/model/key.
 * Omitting options uses saved preferences + env keys.
 */
export const createLlmClient = (options = {}) => {
  const cfg = resolveLlmConfig(options);
  return {
    config: () => ({ ...cfg, apiKey: cfg.apiKey ? "[redacted]" : "" }),
    rawConfig: () => ({ ...cfg }),
    provider: cfg.provider,
    model: cfg.model,
    /** OpenAI-shaped chat completions (Gemini translated to same shape). */
    complete: (body) => complete(cfg, body),
    /** Alias */
    chat: (body) => complete(cfg, body),
  };
};

export {
  listProviders,
  PROVIDERS,
  resolveLlmConfig,
  getLlmSettingsPublic,
  saveLlmSettings,
  setRuntimeLlmKey,
  clearRuntimeLlmKey,
  complete,
};

// Back-compat aliases
export const getChatSettingsPublic = getLlmSettingsPublic;
export const saveChatSettings = saveLlmSettings;
export const chatCompletions = (cfg, body) => complete(cfg, body);
