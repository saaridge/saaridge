import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../paths.js";
import { listProviders, resolveLlmConfig as resolveRaw } from "./providers.js";

const SETTINGS_FILE = path.join(STATE_DIR, "llm-settings.json");

/** In-memory API key for this process only (never written to disk). */
let runtimeApiKey = "";
let runtimeProvider = "";

export const setRuntimeLlmKey = ({ apiKey, provider } = {}) => {
  if (apiKey !== undefined) {
    runtimeApiKey = apiKey ? String(apiKey) : "";
  }
  if (provider) runtimeProvider = String(provider);
  return {
    hasRuntimeKey: Boolean(runtimeApiKey),
    provider: runtimeProvider || null,
  };
};

export const clearRuntimeLlmKey = () => {
  runtimeApiKey = "";
  runtimeProvider = "";
  return { hasRuntimeKey: false };
};

const readSettings = () => {
  try {
    // Migrate old chat-settings.json if present
    const legacy = path.join(STATE_DIR, "chat-settings.json");
    if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(legacy)) {
      const old = JSON.parse(fs.readFileSync(legacy, "utf8"));
      delete old.apiKey;
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(old, null, 2));
    }
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
};

const writeSettings = (data) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const safe = { ...data };
  delete safe.apiKey;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(safe, null, 2));
};

const ctx = () => ({
  runtimeApiKey,
  runtimeProvider,
  saved: readSettings(),
});

export const resolveLlmConfig = (override = {}) => resolveRaw(override, ctx());

export const getLlmSettingsPublic = () => {
  const saved = readSettings();
  let cfg = null;
  try {
    cfg = resolveLlmConfig();
  } catch {
    cfg = null;
  }
  return {
    provider: cfg?.provider || saved.provider || null,
    label: cfg?.label || null,
    model: cfg?.model || saved.model || null,
    free: cfg?.free || false,
    hasRuntimeKey: Boolean(runtimeApiKey),
    keysFromEnvOnly: true,
    configured: Boolean(cfg),
    providers: listProviders(),
  };
};

/** Persist provider/model preference only — never API keys. */
export const saveLlmSettings = ({ provider, model, apiKey } = {}) => {
  if (apiKey !== undefined || provider) {
    setRuntimeLlmKey({ apiKey, provider });
  }
  const saved = readSettings();
  delete saved.apiKey;
  if (provider) saved.provider = provider;
  if (model !== undefined) saved.model = model || undefined;
  writeSettings(saved);
  return getLlmSettingsPublic();
};
