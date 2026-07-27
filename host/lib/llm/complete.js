/**
 * Execute a chat completion against the resolved provider config.
 * Returns an OpenAI-shaped response for all providers (including Gemini).
 */

const openaiToolsToGemini = (tools) => {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || fn.name,
      parameters: fn.parameters || { type: "object", properties: {} },
    };
  });
};

const toGeminiContents = (messages) => {
  const systemParts = [];
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content || "");
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: {
                result:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content),
              },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.tool_calls || []) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            name: call.function?.name,
            args,
          },
        });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content || "" }] });
    }
  }
  return { systemParts, contents };
};

const geminiResponseToOpenAi = (data, model) => {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  let text = "";
  const tool_calls = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      tool_calls.push({
        id: `call_${tool_calls.length + 1}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {}),
        },
      });
    }
  }
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: tool_calls.length ? tool_calls : undefined,
        },
        finish_reason: tool_calls.length ? "tool_calls" : "stop",
      },
    ],
    model,
  };
};

const completeGemini = async (cfg, body) => {
  const { systemParts, contents } = toGeminiContents(body.messages || []);
  const model = cfg.model || "gemini-2.0-flash";
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

  const payload = {
    contents: contents.length
      ? contents
      : [{ role: "user", parts: [{ text: "Hello" }] }],
    generationConfig: {
      temperature: body.temperature ?? 0.2,
      maxOutputTokens: body.max_tokens || 2048,
    },
  };
  if (systemParts.length) {
    payload.systemInstruction = {
      parts: [{ text: systemParts.join("\n\n") }],
    };
  }
  const decls = openaiToolsToGemini(body.tools);
  if (decls?.length) {
    payload.tools = [{ functionDeclarations: decls }];
    payload.toolConfig = {
      functionCallingConfig: {
        mode: body.tool_choice === "none" ? "NONE" : "AUTO",
      },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Gemini returned non-JSON (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    throw new Error(`LLM gemini error ${res.status}: ${msg}`);
  }
  return geminiResponseToOpenAi(json, model);
};

const completeOpenAiCompatible = async (cfg, body) => {
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey && cfg.authStyle === "bearer") {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      ...body,
    }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `LLM returned non-JSON (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.details?.error?.message ||
      json?.error ||
      text.slice(0, 300);
    throw new Error(`LLM ${cfg.provider} error ${res.status}: ${msg}`);
  }
  return json;
};

const completeAnthropic = async (cfg, body) => {
  const messages = [];
  let system = "";
  for (const m of body.messages || []) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + (m.content || "");
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      messages.push({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }
  if (!messages.length) {
    messages.push({ role: "user", content: "Hello" });
  }

  const payload = {
    model: cfg.model,
    max_tokens: body.max_tokens || 2048,
    temperature: body.temperature ?? 0.2,
    messages,
  };
  if (system) payload.system = system;

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Anthropic returned non-JSON (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    throw new Error(`LLM anthropic error ${res.status}: ${msg}`);
  }
  const content =
    (json.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("") || null;
  return {
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: json.stop_reason || "stop",
      },
    ],
    model: json.model || cfg.model,
  };
};

export const complete = async (cfg, body) => {
  if (cfg.provider === "gemini" || cfg.authStyle === "gemini") {
    return completeGemini(cfg, body);
  }
  if (cfg.provider === "anthropic" || cfg.authStyle === "anthropic") {
    return completeAnthropic(cfg, body);
  }
  return completeOpenAiCompatible(cfg, body);
};
