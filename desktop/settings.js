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
      opt.textContent = algo.name || algo.id;
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
      policyCell.innerHTML = `<div><strong>${meta.name || row.algorithmId}</strong></div>
        <div class="sub">${row.algorithmId}</div>`;

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

  const renderCoverageSummary = (algorithms) => {
    const body = $("coverageBody");
    if (!body) return;
    body.innerHTML = "";
    for (const algo of algorithms || []) {
      const block = document.createElement("div");
      block.className = `coverage-policy${algo.enabledGlobally ? "" : " off"}`;
      const title = document.createElement("strong");
      title.textContent = `${algo.name}${algo.enabledGlobally ? "" : " (off)"}`;
      block.appendChild(title);
      const ul = document.createElement("ul");
      const cats = (algo.categories || []).filter((c) => c.enabled);
      if (!algo.enabledGlobally) {
        const li = document.createElement("li");
        li.textContent = "Turned off — assistants are not checked by this rule.";
        ul.appendChild(li);
      } else if (!cats.length) {
        const li = document.createElement("li");
        li.textContent = "Nothing selected in Customize.";
        ul.appendChild(li);
      } else {
        for (const c of cats) {
          const li = document.createElement("li");
          li.textContent = c.label;
          ul.appendChild(li);
        }
        if (algo.supportsKnownValues && (algo.knownValues || []).length) {
          const li = document.createElement("li");
          li.textContent = `Your phrases: ${(algo.knownValues || []).join(", ")}`;
          ul.appendChild(li);
        }
      }
      block.appendChild(ul);
      body.appendChild(block);
    }
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
      $("policyMeta").textContent = `Saved only on this Mac: ${status.configPath || ""}`;

      renderCoverageSummary(global.algorithms || []);

      const globalRoot = $("globalRows");
      globalRoot.innerHTML = "";
      const modeLabels = {
        redact: "Redact",
        block: "Block",
        allow: "Allow",
      };
      const modeExplain = {
        redact: "Matched values are replaced; the rest continues.",
        block: "The whole request is stopped.",
        allow: "Matching content is left alone (free flow).",
      };
      for (const algo of global.algorithms || []) {
        const card = document.createElement("div");
        card.className = `policy-card${algo.enabledGlobally ? "" : " disabled-card"}`;

        const head = document.createElement("div");
        head.className = "policy-card-head";

        const title = document.createElement("h5");
        title.appendChild(document.createTextNode(algo.name || algo.id));
        const onBadge = document.createElement("span");
        onBadge.className = `policy-badge${algo.enabledGlobally ? "" : " off"}`;
        onBadge.textContent = algo.enabledGlobally ? "Enabled" : "Disabled";
        title.appendChild(onBadge);
        if (algo.enabledGlobally) {
          const modeBadge = document.createElement("span");
          modeBadge.className = "policy-badge mode";
          modeBadge.textContent = modeLabels[algo.mode] || algo.mode || "Redact";
          title.appendChild(modeBadge);
        }
        head.appendChild(title);

        const infoWrap = document.createElement("div");
        infoWrap.className = "policy-info";
        const infoBtn = document.createElement("button");
        infoBtn.type = "button";
        infoBtn.className = "policy-info-btn";
        infoBtn.setAttribute("aria-label", `About ${algo.name || algo.id}`);
        infoBtn.setAttribute("aria-expanded", "false");
        infoBtn.textContent = "i";
        const tip = document.createElement("div");
        tip.className = "policy-info-tip";
        tip.setAttribute("role", "tooltip");
        const tipTitle = document.createElement("strong");
        tipTitle.textContent = algo.name || algo.id;
        tip.appendChild(tipTitle);
        tip.appendChild(
          document.createTextNode(
            algo.info ||
              algo.description ||
              "Controls how this kind of sensitive data is shown to assistants.",
          ),
        );
        const tipMode = document.createElement("p");
        tipMode.style.margin = "0.55rem 0 0";
        tipMode.style.color = "#8fa79b";
        const activeMode = algo.enabledGlobally
          ? modeLabels[algo.mode] || algo.mode
          : "Disabled";
        tipMode.textContent = `Current setting: ${activeMode}. ${
          algo.enabledGlobally
            ? modeExplain[algo.mode] || ""
            : "Turn on Enabled to use this rule."
        }`;
        tip.appendChild(tipMode);
        infoBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const open = tip.classList.toggle("open");
          infoBtn.setAttribute("aria-expanded", open ? "true" : "false");
          document.querySelectorAll(".policy-info-tip.open").forEach((el) => {
            if (el !== tip) {
              el.classList.remove("open");
              el.previousElementSibling?.setAttribute?.("aria-expanded", "false");
            }
          });
        });
        infoWrap.appendChild(infoBtn);
        infoWrap.appendChild(tip);
        head.appendChild(infoWrap);
        card.appendChild(head);

        const desc = document.createElement("p");
        desc.className = "desc";
        desc.textContent = algo.description || "";
        card.appendChild(desc);

        // What this checks — chips
        const checksLabel = document.createElement("div");
        checksLabel.className = "control-label";
        checksLabel.textContent = "What this checks";
        card.appendChild(checksLabel);
        const chips = document.createElement("div");
        chips.className = "chip-row";
        const enabledCats = (algo.categories || []).filter((c) => c.enabled);
        if (!enabledCats.length) {
          const chip = document.createElement("span");
          chip.className = "chip muted";
          chip.textContent = "Nothing selected";
          chips.appendChild(chip);
        } else {
          for (const c of enabledCats) {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.textContent = c.label;
            chips.appendChild(chip);
          }
        }
        if (algo.customized) {
          const chip = document.createElement("span");
          chip.className = "chip muted";
          chip.textContent = "Customized";
          chips.appendChild(chip);
        }
        card.appendChild(chips);

        const controls = document.createElement("div");
        controls.className = "controls";

        const modeCol = document.createElement("div");
        const modeLabel = document.createElement("div");
        modeLabel.className = "control-label";
        modeLabel.textContent = "When found";
        modeCol.appendChild(modeLabel);

        const modes =
          Array.isArray(algo.allowModes) && algo.allowModes.length
            ? algo.allowModes
            : ["redact", "block", "allow"];
        const modeGroup = document.createElement("div");
        modeGroup.className = "mode-group";
        modeGroup.setAttribute("role", "radiogroup");
        modeGroup.setAttribute("aria-label", `${algo.name} mode`);
        for (const mode of modes) {
          const lab = document.createElement("label");
          const input = document.createElement("input");
          input.type = "radio";
          input.name = `mode-${algo.id}`;
          input.value = mode;
          input.checked = (algo.mode || "redact") === mode;
          input.disabled = !algo.enabledGlobally;
          input.addEventListener("change", async () => {
            if (!input.checked) return;
            try {
              await api("/api/policies/mode", {
                method: "POST",
                body: JSON.stringify({ algorithmId: algo.id, mode }),
              });
              setPolicyStatus(`${algo.name}: ${modeLabels[mode]}`);
              await reloadPolicies();
            } catch (err) {
              setPolicyStatus(String(err.message || err), true);
            }
          });
          lab.appendChild(input);
          lab.appendChild(document.createTextNode(modeLabels[mode] || mode));
          modeGroup.appendChild(lab);
        }
        modeCol.appendChild(modeGroup);
        controls.appendChild(modeCol);

        const toggle = document.createElement("label");
        toggle.className = "toggle-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!algo.enabledGlobally;
        cb.addEventListener("change", async () => {
          cb.disabled = true;
          try {
            await api("/api/policies/global", {
              method: "POST",
              body: JSON.stringify({
                algorithmId: algo.id,
                enabled: cb.checked,
              }),
            });
            await reloadPolicies();
          } catch (err) {
            setPolicyStatus(String(err.message || err), true);
            cb.disabled = false;
          }
        });
        toggle.appendChild(cb);
        toggle.appendChild(
          document.createTextNode(algo.enabledGlobally ? "Enabled" : "Disabled"),
        );
        controls.appendChild(toggle);
        card.appendChild(controls);

        // Customize disclosure
        const customize = document.createElement("details");
        customize.className = "customize";
        const sum = document.createElement("summary");
        sum.textContent = "Customize what this checks";
        customize.appendChild(sum);
        const body = document.createElement("div");
        body.className = "customize-body";

        for (const c of algo.categories || []) {
          const row = document.createElement("label");
          row.className = "cat-row";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = !!c.enabled;
          input.disabled = !algo.enabledGlobally;
          input.addEventListener("change", async () => {
            const map = {};
            for (const x of algo.categories || []) {
              map[x.id] = x.id === c.id ? input.checked : !!x.enabled;
            }
            try {
              await api("/api/policies/categories", {
                method: "POST",
                body: JSON.stringify({
                  algorithmId: algo.id,
                  categories: map,
                }),
              });
              await reloadPolicies();
            } catch (err) {
              setPolicyStatus(String(err.message || err), true);
              input.checked = !input.checked;
            }
          });
          const label = document.createElement("span");
          label.className = "cat-label";
          label.textContent = c.label;
          const help = document.createElement("p");
          help.className = "cat-help";
          help.textContent = c.description || "";
          row.appendChild(input);
          row.appendChild(label);
          row.appendChild(help);
          body.appendChild(row);
        }

        if (algo.supportsKnownValues) {
          const wordsBox = document.createElement("div");
          wordsBox.className = "words-box";
          const wordsHelp = document.createElement("p");
          wordsHelp.className = "cat-help";
          wordsHelp.style.margin = "0";
          wordsHelp.textContent =
            "Add names or phrases (at least 3 characters). Matching text is handled using the When found setting above.";
          wordsBox.appendChild(wordsHelp);

          const list = document.createElement("ul");
          list.className = "words-list";
          const values = [...(algo.knownValues || [])];
          const renderWords = () => {
            list.innerHTML = "";
            if (!values.length) {
              const empty = document.createElement("p");
              empty.className = "words-empty";
              empty.textContent = "No phrases yet.";
              list.appendChild(empty);
              return;
            }
            for (const word of values) {
              const li = document.createElement("li");
              const span = document.createElement("span");
              span.textContent = word;
              const rm = document.createElement("button");
              rm.type = "button";
              rm.className = "btn danger";
              rm.textContent = "Remove";
              rm.disabled = !algo.enabledGlobally;
              rm.addEventListener("click", async () => {
                const next = values.filter((w) => w !== word);
                try {
                  await api("/api/policies/known-values", {
                    method: "POST",
                    body: JSON.stringify({
                      algorithmId: algo.id,
                      values: next,
                    }),
                  });
                  await reloadPolicies();
                } catch (err) {
                  setPolicyStatus(String(err.message || err), true);
                }
              });
              li.appendChild(span);
              li.appendChild(rm);
              list.appendChild(li);
            }
          };
          renderWords();
          wordsBox.appendChild(list);

          const addRow = document.createElement("div");
          addRow.className = "words-add";
          const input = document.createElement("input");
          input.type = "text";
          input.placeholder = "e.g. Jane Doe";
          input.disabled = !algo.enabledGlobally;
          const addBtn = document.createElement("button");
          addBtn.type = "button";
          addBtn.className = "btn primary";
          addBtn.textContent = "Add";
          addBtn.disabled = !algo.enabledGlobally;
          const saveWord = async () => {
            const v = input.value.trim();
            if (v.length < 3) {
              setPolicyStatus("Use at least 3 characters", true);
              return;
            }
            const next = [...new Set([...values, v])];
            try {
              await api("/api/policies/known-values", {
                method: "POST",
                body: JSON.stringify({ algorithmId: algo.id, values: next }),
              });
              input.value = "";
              await reloadPolicies();
            } catch (err) {
              setPolicyStatus(String(err.message || err), true);
            }
          };
          addBtn.addEventListener("click", saveWord);
          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              void saveWord();
            }
          });
          addRow.appendChild(input);
          addRow.appendChild(addBtn);
          wordsBox.appendChild(addRow);
          body.appendChild(wordsBox);
        }

        customize.appendChild(body);
        card.appendChild(customize);

        globalRoot.appendChild(card);
      }
      if (!(global.algorithms || []).length) {
        globalRoot.innerHTML = '<p class="sub">No policies registered</p>';
      }

      renderOverrides();
      setPolicyStatus("");
    } catch (err) {
      $("policyMeta").textContent = "Could not reach policy API — is the host running?";
      setPolicyStatus(String(err.message || err), true);
    }
  };

  $("btnPolicyRefresh").addEventListener("click", () => reloadPolicies());

  document.addEventListener("click", () => {
    document.querySelectorAll(".policy-info-tip.open").forEach((el) => {
      el.classList.remove("open");
      el.previousElementSibling?.setAttribute?.("aria-expanded", "false");
    });
  });

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
