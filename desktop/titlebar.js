(() => {
  const uiActions = document.getElementById("uiActions");
  const btnApiKey = document.getElementById("btnApiKey");
  const osBadge = document.getElementById("osBadge");
  const osLabel = document.getElementById("osLabel");

  const unlock = () => {
    uiActions.classList.remove("locked");
    btnApiKey.disabled = false;
  };

  const showOs = (os) => {
    if (!os || !osLabel || !osBadge) return;
    osLabel.textContent = os.label || "Linux";
    osBadge.title = os.detail || "Sandbox desktop OS";
    osBadge.hidden = false;
  };

  btnApiKey?.addEventListener("click", () => {
    void window.onebridge?.openApiKey?.();
  });

  // Clicking the bar (non-buttons) should return keyboard to the desktop.
  document.body.addEventListener("pointerup", (ev) => {
    if (ev.target.closest("button")) return;
    void window.onebridge?.focusDesktop?.();
  });

  (async () => {
    try {
      if (window.onebridge?.platform && window.onebridge.platform !== "darwin") {
        document.querySelector(".titlebar")?.style.setProperty("padding-left", "12px");
      }
      const urls = await window.onebridge?.getUrls?.();
      const control = urls?.control || "http://127.0.0.1:3847";
      try {
        const r = await fetch(`${control}/api/workspace/os`);
        const j = await r.json();
        if (j?.os) showOs(j.os);
      } catch (_) {}
      unlock();
    } catch (_) {
      unlock();
    }
  })();
})();
