(() => {
  let control = "http://127.0.0.1:3847";
  let defaults = {};
  let presets = {};

  const $ = (id) => document.getElementById(id);
  const status = (msg, isErr = false) => {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  };

  const fillSelect = (el, options, selected) => {
    el.innerHTML = "";
    const values = [...(options || [])];
    if (selected && !values.includes(String(selected))) values.unshift(String(selected));
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (String(v) === String(selected)) opt.selected = true;
      el.appendChild(opt);
    }
  };

  const applyValues = (resources) => {
    fillSelect($("resMemory"), presets.memory, resources.memory);
    fillSelect($("resCpus"), presets.cpus, resources.cpus);
    fillSelect($("resShm"), presets.shmSize, resources.shmSize);
    fillSelect($("resTmpfs"), presets.tmpfsSize, resources.tmpfsSize);
    fillSelect($("resResolution"), presets.resolution, resources.resolution);
  };

  const payload = () => ({
    memory: $("resMemory").value,
    cpus: $("resCpus").value,
    shmSize: $("resShm").value,
    tmpfsSize: $("resTmpfs").value,
    resolution: $("resResolution").value,
  });

  $("btnDefaults").addEventListener("click", () => applyValues(defaults));

  $("btnContinue").addEventListener("click", async () => {
    const btn = $("btnContinue");
    btn.disabled = true;
    $("btnDefaults").disabled = true;
    status("Saving resource preferences…");
    try {
      // Save only — workspace start/recreate happens after this wizard closes.
      const res = await fetch(`${control}/api/resources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      await window.saaridge?.completeFirstRunResources?.(payload());
    } catch (err) {
      status(String(err.message || err), true);
      btn.disabled = false;
      $("btnDefaults").disabled = false;
    }
  });

  (async () => {
    try {
      const urls = await window.saaridge?.getUrls?.();
      if (urls?.control) control = urls.control;
    } catch (_) {}
    try {
      const r = await fetch(`${control}/api/resources`);
      const j = await r.json();
      defaults = j.defaults || j.resources || {};
      presets = j.presets || {};
      applyValues(j.resources || defaults);
    } catch (err) {
      status(String(err.message || err), true);
    }
  })();
})();
