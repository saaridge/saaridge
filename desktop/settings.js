(() => {
  let control = "http://127.0.0.1:3847";
  let providers = [];
  let policyCache = { agents: [], global: { algorithms: [] } };

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const initialPane =
    params.get("pane") === "apikey"
      ? "apikey"
      : params.get("pane") === "microphone"
        ? "microphone"
        : "policies";

  const setPolicyStatus = (msg, isErr = false) => {
    const el = $("policyStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  };

  const api = async (path, opts = {}) => {
    const res = await fetch(`${control}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  };

  const showPane = (pane) => {
    const policies = pane === "policies";
    const mic = pane === "microphone";
    const apikey = pane === "apikey";
    $("pane-policies").hidden = !policies;
    $("pane-microphone").hidden = !mic;
    $("pane-apikey").hidden = !apikey;
    $("navPolicies").classList.toggle("active", policies);
    $("navMic").classList.toggle("active", mic);
    $("navApiKey").classList.toggle("active", apikey);
    if (policies) void reloadPolicies();
    else if (mic) void reloadMic();
    else void reloadApiKey();
  };

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPane(btn.dataset.pane));
  });

  const closeSettings = () => window.close();
  $("btnClosePolicies")?.addEventListener("click", closeSettings);
  $("btnCloseMic")?.addEventListener("click", closeSettings);
  $("keyCancel")?.addEventListener("click", closeSettings);

  const modeLabel = (mode) =>
    mode === "on" ? "Force on" : mode === "off" ? "Force off" : "Follow global";

  const collectOverrides = (agents, globalAlgos) => {
    const rows = [];
    const seen = new Set();
    for (const agent of agents || []) {
      const fromAlgorithms = agent.algorithms || [];
      for (const state of fromAlgorithms) {
        if (!state.id || state.mode === "follow" || !state.mode) continue;
        const key = `${agent.agentId}:${state.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          agentId: agent.agentId,
          agentName: agent.name || agent.agentId,
          algorithmId: state.id,
          mode: state.mode,
        });
      }
      const overrides = agent.overrides || {};
      for (const [algorithmId, value] of Object.entries(overrides)) {
        const key = `${agent.agentId}:${algorithmId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          agentId: agent.agentId,
          agentName: agent.name || agent.agentId,
          algorithmId,
          mode: value === true ? "on" : "off",
        });
      }
    }
    rows.sort((a, b) =>
      `${a.agentName}:${a.algorithmId}`.localeCompare(
        `${b.agentName}:${b.algorithmId}`,
      ),
    );
    return rows;
  };

  const fillOverrideForm = () => {
    const agentSel = $("overrideAgent");
    const policySel = $("overridePolicy");
    if (!agentSel || !policySel) return;

    const agents = policyCache.agents || [];
    const algos = policyCache.global?.algorithms || [];

    agentSel.innerHTML = "";
    const agentPlaceholder = document.createElement("option");
    agentPlaceholder.value = "";
    agentPlaceholder.textContent =
      agents.length ? "Select agent…" : "No agents yet";
    agentSel.appendChild(agentPlaceholder);
    for (const agent of agents) {
      const opt = document.createElement("option");
      opt.value = agent.agentId;
      opt.textContent = agent.name || agent.agentId;
      agentSel.appendChild(opt);
    }

    policySel.innerHTML = "";
    const policyPlaceholder = document.createElement("option");
    policyPlaceholder.value = "";
    policyPlaceholder.textContent =
      algos.length ? "Select policy…" : "No policies registered";
    policySel.appendChild(policyPlaceholder);
    for (const algo of algos) {
      const opt = document.createElement("option");
      opt.value = algo.id;
      opt.textContent = algo.name ? `${algo.id} — ${algo.name}` : algo.id;
      policySel.appendChild(opt);
    }

    $("btnAddOverride").disabled = !agents.length || !algos.length;
  };

  const renderOverrides = () => {
    const root = $("overrideRows");
    if (!root) return;
    const algos = policyCache.global?.algorithms || [];
    const algoMeta = Object.fromEntries(algos.map((a) => [a.id, a]));
    const rows = collectOverrides(policyCache.agents, algos);

    if (!rows.length) {
      root.innerHTML =
        '<p class="override-empty">No overrides yet. Use the form below to add one.</p>';
      fillOverrideForm();
      return;
    }

    const table = document.createElement("table");
    table.className = "override-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Agent</th>
          <th>Policy</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    for (const row of rows) {
      const meta = algoMeta[row.algorithmId] || {};
      const tr = document.createElement("tr");
      const statusCell = document.createElement("td");
      const tagClass = row.mode === "off" ? "tag off" : "tag";
      statusCell.innerHTML = `<span class="${tagClass}">${modeLabel(row.mode)}</span>`;

      const agentCell = document.createElement("td");
      agentCell.innerHTML = `<div><strong>${row.agentName}</strong></div>
        <div class="sub">${row.agentId}</div>`;

      const policyCell = document.createElement("td");
      policyCell.innerHTML = `<div><strong>${row.algorithmId}</strong></div>
        <div class="sub">${meta.name || ""}</div>`;

      const actionCell = document.createElement("td");
      actionCell.style.textAlign = "right";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        removeBtn.disabled = true;
        setPolicyStatus("Removing…");
        try {
          await api("/api/policies/bindings/override", {
            method: "POST",
            body: JSON.stringify({
              agentId: row.agentId,
              algorithmId: row.algorithmId,
              mode: "follow",
            }),
          });
          await reloadPolicies();
        } catch (err) {
          setPolicyStatus(String(err.message || err), true);
          removeBtn.disabled = false;
        }
      });
      actionCell.appendChild(removeBtn);

      tr.appendChild(agentCell);
      tr.appendChild(policyCell);
      tr.appendChild(statusCell);
      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    }

    root.innerHTML = "";
    root.appendChild(table);
    fillOverrideForm();
  };

  const reloadPolicies = async () => {
    setPolicyStatus("Loading…");
    try {
      const [status, global, agentsRes] = await Promise.all([
        api("/api/policies/status"),
        api("/api/policies/global"),
        api("/api/policies/agents"),
      ]);
      policyCache = {
        agents: agentsRes.agents || [],
        global,
      };
      $("policyMeta").textContent = `Private host config: ${status.configPath || ""}`;

      const globalRoot = $("globalRows");
      globalRoot.innerHTML = "";
      for (const algo of global.algorithms || []) {
        const row = document.createElement("div");
        row.className = "row";
        const left = document.createElement("div");
        left.innerHTML = `<div><strong>${algo.id}</strong>${
          algo.enabledGlobally ? '<span class="tag">on</span>' : ""
        }</div><div class="sub">${algo.name || ""}</div>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn";
        btn.textContent = algo.enabledGlobally ? "Disable global" : "Enable global";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/api/policies/global", {
              method: "POST",
              body: JSON.stringify({
                algorithmId: algo.id,
                enabled: !algo.enabledGlobally,
              }),
            });
            await reloadPolicies();
          } catch (err) {
            setPolicyStatus(String(err.message || err), true);
            btn.disabled = false;
          }
        });
        row.appendChild(left);
        row.appendChild(btn);
        globalRoot.appendChild(row);
      }
      if (!(global.algorithms || []).length) {
        globalRoot.innerHTML = '<p class="sub">No algorithms registered</p>';
      }

      renderOverrides();
      setPolicyStatus("");
    } catch (err) {
      $("policyMeta").textContent = "Could not reach policy API — is the host running?";
      setPolicyStatus(String(err.message || err), true);
    }
  };

  $("btnPolicyRefresh").addEventListener("click", () => reloadPolicies());

  $("btnAddOverride")?.addEventListener("click", async () => {
    const agentId = $("overrideAgent")?.value;
    const algorithmId = $("overridePolicy")?.value;
    const mode = $("overrideMode")?.value;
    if (!agentId || !algorithmId) {
      setPolicyStatus("Choose an agent and policy first", true);
      return;
    }
    const dup = collectOverrides(policyCache.agents, policyCache.global?.algorithms || []).some(
      (r) => r.agentId === agentId && r.algorithmId === algorithmId,
    );
    if (dup) {
      setPolicyStatus("That override already exists — remove it first to change it", true);
      return;
    }
    const btn = $("btnAddOverride");
    btn.disabled = true;
    setPolicyStatus("Saving…");
    try {
      await api("/api/policies/agents/ensure", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      await api("/api/policies/bindings/override", {
        method: "POST",
        body: JSON.stringify({ agentId, algorithmId, mode }),
      });
      await reloadPolicies();
    } catch (err) {
      setPolicyStatus(String(err.message || err), true);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Microphone ---
  const micToggle = $("micToggle");
  const micToggleLabel = $("micToggleLabel");
  const micStatus = $("micStatus");

  const applyMicStatus = (payload) => {
    if (!micStatus) return;
    const msg = payload?.message || payload?.state || "";
    micStatus.textContent = msg;
    micStatus.classList.toggle("err", payload?.state === "denied" || payload?.state === "error");
  };

  const reloadMic = async () => {
    try {
      const prefs = await window.onebridge?.getMicPrefs?.();
      const on = !!prefs?.shareMic;
      micToggle.checked = on;
      micToggleLabel.textContent = on ? "On" : "Off";
      applyMicStatus(
        prefs?.status || {
          state: on ? "waiting" : "off",
          message: on ? "Starting…" : "Microphone sharing is off",
        },
      );
    } catch (err) {
      applyMicStatus({ state: "error", message: String(err.message || err) });
    }
  };

  micToggle?.addEventListener("change", async () => {
    const shareMic = !!micToggle.checked;
    micToggleLabel.textContent = shareMic ? "On" : "Off";
    micToggle.disabled = true;
    try {
      const r = await window.onebridge?.setMicPrefs?.({ shareMic });
      applyMicStatus(
        r?.status || {
          state: shareMic ? "waiting" : "off",
          message: shareMic
            ? "Waiting for microphone permission…"
            : "Microphone sharing is off",
        },
      );
    } catch (err) {
      micToggle.checked = !shareMic;
      micToggleLabel.textContent = micToggle.checked ? "On" : "Off";
      applyMicStatus({ state: "error", message: String(err.message || err) });
    } finally {
      micToggle.disabled = false;
    }
  });

  window.onebridge?.onMicStatus?.((payload) => applyMicStatus(payload));

  // --- API key ---
  const providerSelect = $("providerSelect");
  const modelSelect = $("modelSelect");
  const apiKeyInput = $("apiKeyInput");
  const apiKeyLabel = $("apiKeyLabel");
  const keyStatus = $("keyStatus");
  const keyForm = $("keyForm");

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
    if (
      preferredModel &&
      [...modelSelect.options].some((o) => o.value === preferredModel)
    ) {
      modelSelect.value = preferredModel;
    } else if (p?.defaultModel) {
      modelSelect.value = p.defaultModel;
    }
  };

  const updateProviderInfo = () => {
    const p = selectedProvider();
    if (!p) return;
    $("providerName").textContent = p.label;
    $("providerDesc").textContent = p.description || "";
    $("providerHint").textContent =
      p.needsKey === false
        ? "No API key required for local Ollama."
        : `Key format: ${p.keyHint || "see provider docs"}`;
    const docs = $("providerDocs");
    if (p.docsUrl) {
      docs.href = p.docsUrl;
      docs.textContent = `Get a ${p.label} API key`;
      docs.hidden = false;
    } else {
      docs.hidden = true;
    }
    const needsKey = p.needsKey !== false;
    apiKeyLabel.style.display = needsKey ? "grid" : "none";
    if (!needsKey) apiKeyInput.value = "";
  };

  providerSelect.addEventListener("change", () => {
    fillModels(providerSelect.value);
    updateProviderInfo();
  });

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
      keyStatus.classList.add("err");
    }
  });

  const reloadApiKey = async () => {
    keyStatus.classList.remove("err");
    try {
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
      keyStatus.classList.add("err");
    }
  };

  (async () => {
    try {
      const urls = await window.onebridge?.getUrls?.();
      if (urls?.control) control = urls.control;
    } catch (_) {}
    showPane(initialPane);
  })();
})();
