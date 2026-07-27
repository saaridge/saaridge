(() => {
  const keyForm = document.getElementById("keyForm");
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const apiKeyLabel = document.getElementById("apiKeyLabel");
  const keyStatus = document.getElementById("keyStatus");
  const keyCancel = document.getElementById("keyCancel");
  const providerName = document.getElementById("providerName");
  const providerDesc = document.getElementById("providerDesc");
  const providerHint = document.getElementById("providerHint");
  const providerDocs = document.getElementById("providerDocs");

  let control = "http://127.0.0.1:3847";
  let providers = [];

  const selectedProvider = () =>
    providers.find((x) => x.id === providerSelect.value) || null;

  const fillModels = (providerId, preferredModel) => {
    const p = providers.find((x) => x.id === providerId);
    const models = p?.models || [];
    modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    }
    if (preferredModel && [...modelSelect.options].some((o) => o.value === preferredModel)) {
      modelSelect.value = preferredModel;
    } else if (p?.defaultModel) {
      modelSelect.value = p.defaultModel;
    }
  };

  const updateProviderInfo = () => {
    const p = selectedProvider();
    if (!p) return;
    providerName.textContent = p.label;
    providerDesc.textContent = p.description || "";
    providerHint.textContent =
      p.needsKey === false
        ? "No API key required for local Ollama."
        : `Key format: ${p.keyHint || "see provider docs"}`;
    if (p.docsUrl) {
      providerDocs.href = p.docsUrl;
      providerDocs.textContent = `Get a ${p.label} API key`;
      providerDocs.hidden = false;
    } else {
      providerDocs.hidden = true;
    }
    const needsKey = p.needsKey !== false;
    apiKeyLabel.style.display = needsKey ? "grid" : "none";
    if (!needsKey) apiKeyInput.value = "";
  };

  providerSelect.addEventListener("change", () => {
    fillModels(providerSelect.value);
    updateProviderInfo();
  });
  keyCancel.addEventListener("click", () => window.close());

  keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = selectedProvider();
    try {
      const r = await fetch(`${control}/api/llm/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: providerSelect.value,
          model: modelSelect.value,
          apiKey: p?.needsKey === false ? "" : apiKeyInput.value.trim(),
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Save failed");
      window.close();
    } catch (err) {
      keyStatus.textContent = String(err.message || err);
    }
  });

  (async () => {
    try {
      const urls = await window.onebridge?.getUrls?.();
      control = urls?.control || control;
      const r = await fetch(`${control}/api/llm/settings`);
      const j = await r.json();
      providers = j.settings?.providers || [];
      providerSelect.innerHTML = "";
      for (const p of providers) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        providerSelect.appendChild(opt);
      }
      providerSelect.value = j.settings?.provider || providers[0]?.id || "gemini";
      fillModels(providerSelect.value, j.settings?.model);
      updateProviderInfo();
      keyStatus.textContent = j.settings?.configured
        ? `Active: ${j.settings.label || j.settings.provider}`
        : "Not configured yet";
    } catch (err) {
      keyStatus.textContent = String(err.message || err);
    }
  })();
})();
