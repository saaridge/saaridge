(() => {
  const boot = document.getElementById("boot");
  const bootMsg = document.getElementById("bootMsg");
  const bootBar = document.getElementById("bootBar");
  const bootPct = document.getElementById("bootPct");
  const bootPhase = document.getElementById("bootPhase");
  const bootCheck = document.getElementById("bootCheck");
  const bootCheckPhase = document.getElementById("bootCheckPhase");
  const uiActions = document.getElementById("uiActions");
  const btnApiKey = document.getElementById("btnApiKey");
  const osBadge = document.getElementById("osBadge");
  const osLabel = document.getElementById("osLabel");

  let displayedProgress = 0;

  /** Boot UI phase → short label under the progress bar. */
  const PHASE_LABELS = {
    boot: "Starting",
    docker: "Docker",
    host: "Control plane",
    checking: "Workspace",
    building: "Building image",
    image_ready: "Image ready",
    starting: "Starting container",
    container_up: "Container",
    desktop: "Desktop",
    stream: "Desktop stream",
    desktop_wait: "Desktop",
    ready: "Ready",
    error: "Error",
    hostfs_start: "Host drive",
    hostfs_credentials: "Host drive · credentials",
    hostfs_watchdog: "Host drive · watchdog",
    hostfs_mount: "Host drive · mount",
    hostfs_browse: "Host drive · folders",
    hostfs_remount: "Host drive · remount",
    hostfs_ready: "Host drive · ready",
    hostfs_error: "Host drive · failed",
  };

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
    if (phase) {
      const key = String(phase);
      bootPhase.textContent =
        PHASE_LABELS[key] || key.replace(/_/g, " ");
      if (bootCheck) {
        bootCheck.hidden = key === "ready" || key === "error" || key === "idle";
        if (bootCheckPhase) {
          bootCheckPhase.textContent =
            message || PHASE_LABELS[key] || key.replace(/_/g, " ");
        }
      }
    }
    if (message) bootMsg.textContent = message;
  };

  const fail = (err) => {
    boot.classList.add("err");
    bootMsg.textContent = String(err?.message || err || "Failed to start");
    bootPhase.textContent = "Error";
    if (bootCheck) bootCheck.hidden = true;
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
