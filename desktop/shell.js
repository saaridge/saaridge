(() => {
  const boot = document.getElementById("boot");
  const bootMsg = document.getElementById("bootMsg");
  const bootBar = document.getElementById("bootBar");
  const bootPct = document.getElementById("bootPct");
  const bootPhase = document.getElementById("bootPhase");
  const uiActions = document.getElementById("uiActions");
  const btnApiKey = document.getElementById("btnApiKey");
  const btnInstall = document.getElementById("btnInstall");
  const osBadge = document.getElementById("osBadge");
  const osLabel = document.getElementById("osLabel");

  let displayedProgress = 0;

  const showWorkspaceOs = (os) => {
    if (!os || !osLabel || !osBadge) return;
    osLabel.textContent = os.label || "Linux";
    osBadge.title = os.detail || "Sandbox desktop OS";
    osBadge.hidden = false;
  };

  const setProgress = (n, message, phase) => {
    const next = Math.max(displayedProgress, Math.min(100, Number(n) || 0));
    displayedProgress = next;
    bootBar.style.width = `${next}%`;
    bootPct.textContent = `${Math.round(next)}%`;
    if (phase) bootPhase.textContent = String(phase).replace(/_/g, " ");
    if (message) bootMsg.textContent = message;
  };

  const fail = (err) => {
    boot.classList.add("err");
    bootMsg.textContent = String(err?.message || err || "Failed to start");
    bootPhase.textContent = "error";
  };

  if (window.onebridge?.onBoot) {
    window.onebridge.onBoot((payload) => {
      if (!payload || boot.classList.contains("err")) return;
      setProgress(payload.progress, payload.message, payload.phase);
      if (payload.error && payload.phase === "error") {
        fail(payload.error);
      }
    });
  }

  // Hide titlebar controls during boot — real chrome is a BrowserView later.
  if (uiActions) uiActions.style.display = "none";
  if (btnApiKey) btnApiKey.style.display = "none";
  if (btnInstall) btnInstall.style.display = "none";

  (async () => {
    try {
      if (!window.onebridge?.waitReady || !window.onebridge?.showDesktop) {
        throw new Error("Desktop bridge unavailable");
      }
      if (window.onebridge.platform && window.onebridge.platform !== "darwin") {
        document.querySelector(".titlebar")?.style.setProperty("padding-left", "12px");
      }
      setProgress(2, "Starting…", "boot");
      try {
        const urls = await window.onebridge.getUrls?.();
        const control = urls?.control || "http://127.0.0.1:3847";
        const r = await fetch(`${control}/api/workspace/os`);
        const j = await r.json();
        if (j?.os) showWorkspaceOs(j.os);
      } catch (_) {}
      await window.onebridge.waitReady();
      setProgress(100, "Workspace ready", "ready");
      await window.onebridge.showDesktop();
    } catch (err) {
      fail(err);
    }
  })();
})();
