(() => {
  const CONTROL = "http://127.0.0.1:3847";
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg, isErr = false) => {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  };

  const api = async (path, opts = {}) => {
    const res = await fetch(`${CONTROL}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  };

  const makeToggle = (active, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = active ? "On — disable" : "Off — enable";
    if (active) btn.classList.add("on");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await onClick();
        await reload();
      } catch (err) {
        setStatus(String(err.message || err), true);
        btn.disabled = false;
      }
    });
    return btn;
  };

  const reload = async () => {
    setStatus("Loading…");
    try {
      const [status, global, agents] = await Promise.all([
        api("/api/policies/status"),
        api("/api/policies/global"),
        api("/api/policies/agents"),
      ]);
      $("meta").textContent = `Private host config: ${status.configPath || ""}`;

      const globalRoot = $("globalRows");
      globalRoot.innerHTML = "";
      for (const algo of global.algorithms || []) {
        const row = document.createElement("div");
        row.className = "row";
        const left = document.createElement("div");
        left.innerHTML = `<div><strong>${algo.id}</strong>${
          algo.enabledGlobally ? '<span class="tag">global</span>' : ""
        }</div><div class="sub">${algo.name || ""} — ${algo.description || ""}</div>`;
        row.appendChild(left);
        row.appendChild(
          makeToggle(!!algo.enabledGlobally, () =>
            api("/api/policies/global", {
              method: "POST",
              body: JSON.stringify({
                algorithmId: algo.id,
                enabled: !algo.enabledGlobally,
              }),
            }),
          ),
        );
        globalRoot.appendChild(row);
      }
      if (!(global.algorithms || []).length) {
        globalRoot.innerHTML = '<p class="sub">No algorithms registered</p>';
      }

      const agentRoot = $("agentRows");
      agentRoot.innerHTML = "";
      const list = agents.agents || [];
      const algos = global.algorithms || [];
      if (!list.length) {
        agentRoot.innerHTML =
          '<p class="sub">No assistants yet. Install one from the control plane or use the workspace desktop agent.</p>';
      }
      for (const agent of list) {
        const block = document.createElement("div");
        block.className = "agent-block";
        block.innerHTML = `<div class="agent-name">${agent.name || agent.agentId}</div>
          <div class="agent-id">${agent.kind || "agent"} · ${agent.agentId}</div>`;
        for (const algo of algos) {
          const configured = (agent.configuredAlgorithms || []).includes(algo.id);
          const effective = (agent.activeAlgorithms || []).includes(algo.id);
          const viaGlobal = effective && !configured;
          const row = document.createElement("div");
          row.className = "row";
          const left = document.createElement("div");
          left.innerHTML = `<div><strong>${algo.id}</strong>${
            effective ? '<span class="tag">on</span>' : ""
          }${viaGlobal ? '<span class="tag">via global</span>' : ""}</div>`;
          row.appendChild(left);
          row.appendChild(
            makeToggle(configured, () =>
              api(
                configured
                  ? "/api/policies/bindings/disable"
                  : "/api/policies/bindings/enable",
                {
                  method: "POST",
                  body: JSON.stringify({
                    agentId: agent.agentId,
                    algorithmId: algo.id,
                  }),
                },
              ),
            ),
          );
          block.appendChild(row);
        }
        agentRoot.appendChild(block);
      }
      setStatus("");
    } catch (err) {
      $("meta").textContent = "Could not reach policy API";
      setStatus(String(err.message || err), true);
    }
  };

  $("btnRefresh").addEventListener("click", () => reload());
  $("btnClose").addEventListener("click", () => window.close());
  reload();
})();
