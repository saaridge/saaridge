/**
 * Provider catalog for OneBridge bridge LLM calls.
 */

export const PROVIDERS = [
  {
    id: "gemini",
    label: "Google Gemini",
    description: "Google’s Gemini models via AI Studio / Generative Language API.",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
    defaultModel: "gemini-2.0-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authStyle: "gemini",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    keyHint: "Starts with AIza… — from Google AI Studio",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "GPT models from OpenAI (gpt-4o, mini, and related).",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "bearer",
    envKeys: ["OPENAI_API_KEY"],
    keyHint: "Starts with sk-… — from platform.openai.com",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    description: "Claude models via Anthropic’s Messages API (OpenAI-compatible proxy path).",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
    defaultModel: "claude-sonnet-4-20250514",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    keyHint: "Starts with sk-ant-… — from console.anthropic.com",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "groq",
    label: "Groq",
    description: "Fast open-model inference (Llama and others) on GroqCloud.",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    defaultModel: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "bearer",
    envKeys: ["GROQ_API_KEY"],
    keyHint: "Starts with gsk_… — from console.groq.com",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek chat and reasoner models (OpenAI-compatible API).",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    authStyle: "bearer",
    envKeys: ["DEEPSEEK_API_KEY"],
    keyHint: "From platform.deepseek.com",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    description: "Mistral and Mixtral models via La Plateforme.",
    models: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo"],
    defaultModel: "mistral-small-latest",
    baseUrl: "https://api.mistral.ai/v1",
    authStyle: "bearer",
    envKeys: ["MISTRAL_API_KEY"],
    keyHint: "From console.mistral.ai",
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "xai",
    label: "xAI Grok",
    description: "Grok models from xAI (OpenAI-compatible API).",
    models: ["grok-2-latest", "grok-3-mini", "grok-3"],
    defaultModel: "grok-2-latest",
    baseUrl: "https://api.x.ai/v1",
    authStyle: "bearer",
    envKeys: ["XAI_API_KEY"],
    keyHint: "From console.x.ai",
    docsUrl: "https://console.x.ai",
  },
  {
    id: "together",
    label: "Together AI",
    description: "Hosted open models (Llama, Qwen, and more) via Together.",
    models: [
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-7B-Instruct-Turbo",
    ],
    defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    baseUrl: "https://api.together.xyz/v1",
    authStyle: "bearer",
    envKeys: ["TOGETHER_API_KEY"],
    keyHint: "From api.together.xyz",
    docsUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    description: "Fast serverless inference for open models.",
    models: [
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
    defaultModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authStyle: "bearer",
    envKeys: ["FIREWORKS_API_KEY"],
    keyHint: "From fireworks.ai",
    docsUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "One key for many providers (OpenAI, Anthropic, Google, and more).",
    models: [
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash-001",
      "deepseek/deepseek-chat",
    ],
    defaultModel: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "bearer",
    envKeys: ["OPENROUTER_API_KEY"],
    keyHint: "Starts with sk-or-… — from openrouter.ai",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    description: "Run models on your machine. No cloud API key required.",
    models: ["llama3.2", "mistral", "qwen2.5", "phi4"],
    defaultModel: "llama3.2",
    baseUrl: null,
    authStyle: "none",
    envKeys: ["OLLAMA_HOST"],
    keyHint: "No key needed — set OLLAMA_HOST if not localhost",
    docsUrl: "https://ollama.com",
    free: true,
  },
];

const envFirst = (keys) => {
  for (const k of keys || []) {
    if (process.env[k]) return process.env[k];
  }
  return "";
};

export const listProviders = () =>
  PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description || "",
    models: p.models,
    defaultModel: p.defaultModel,
    keyHint: p.keyHint,
    docsUrl: p.docsUrl || null,
    free: Boolean(p.free),
    needsKey: p.authStyle !== "none",
    hasEnvKey: p.id === "ollama" ? true : Boolean(envFirst(p.envKeys)),
  }));

const findProvider = (id) => {
  if (id === "google") return PROVIDERS.find((p) => p.id === "gemini");
  if (id === "claude") return PROVIDERS.find((p) => p.id === "anthropic");
  return PROVIDERS.find((p) => p.id === id) || null;
};

const build = (meta, apiKey, model) => ({
  provider: meta.id,
  label: meta.label,
  baseUrl:
    meta.id === "ollama"
      ? `${(process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`
      : meta.baseUrl,
  apiKey: apiKey || (meta.id === "ollama" ? "ollama" : ""),
  model: model || meta.defaultModel,
  authStyle: meta.authStyle,
  free: Boolean(meta.free),
});

const guessProviderFromKey = (key) => {
  if (!key) return null;
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return "gemini";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("sk-")) return "openai";
  return null;
};

/**
 * Resolve concrete LLM config.
 * @param {object} override - { provider, apiKey, model }
 * @param {object} ctx - { runtimeApiKey, runtimeProvider, saved }
 */
export const resolveLlmConfig = (override = {}, ctx = {}) => {
  const {
    runtimeApiKey = "",
    runtimeProvider = "",
    saved = {},
  } = ctx;

  let providerId = String(
    override.provider ||
      runtimeProvider ||
      saved.provider ||
      process.env.ONEBRIDGE_LLM_PROVIDER ||
      "auto",
  ).toLowerCase();

  const modelOverride =
    override.model || saved.model || process.env.ONEBRIDGE_LLM_MODEL || null;

  const requestKey = override.apiKey
    ? String(override.apiKey)
    : runtimeApiKey || "";

  if (providerId === "auto") {
    providerId =
      guessProviderFromKey(requestKey) ||
      [
        "gemini",
        "openai",
        "anthropic",
        "groq",
        "deepseek",
        "mistral",
        "xai",
        "together",
        "fireworks",
        "openrouter",
      ].find((id) => envFirst(findProvider(id).envKeys)) ||
      (process.env.OLLAMA_HOST ? "ollama" : null);

    if (!providerId) {
      throw new Error(
        "No LLM configured. Choose a provider in API key settings, or set an API key env var.",
      );
    }
  }

  const meta = findProvider(providerId);
  if (!meta) throw new Error(`Unknown LLM provider: ${providerId}`);

  const key =
    requestKey ||
    (meta.id === "ollama" ? "ollama" : envFirst(meta.envKeys));

  if (meta.authStyle !== "none" && !key) {
    throw new Error(
      `No API key for ${meta.label}. Set it in the app or via ${meta.envKeys?.[0] || "env"}.`,
    );
  }

  return build(meta, key, modelOverride);
};
