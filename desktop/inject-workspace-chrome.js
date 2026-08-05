(() => {
  if (document.getElementById("saaridge-chrome")) return true;

  const TITLEBAR_H = 44;
  document.documentElement.style.setProperty(
    "--saaridge-titlebar",
    `${TITLEBAR_H}px`,
  );

  const style = document.createElement("style");
  style.id = "saaridge-chrome-style";
  style.textContent = `
    #saaridge-chrome {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${TITLEBAR_H}px;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0 12px 0 78px;
      border-bottom: 1px solid #24302b;
      background: linear-gradient(180deg, #16201c, #121a17);
      color: #e7f0eb;
      font: 500 13px/1.3 system-ui, -apple-system, sans-serif;
      user-select: none;
      -webkit-app-region: drag;
      pointer-events: auto;
      box-sizing: border-box;
    }
    #saaridge-chrome * { box-sizing: border-box; }
    #saaridge-chrome .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      flex: 0 1 auto;
      overflow: hidden;
    }
    #saaridge-chrome .mark {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: linear-gradient(145deg, #3dba8a, #1f7a58);
      flex-shrink: 0;
    }
    #saaridge-chrome .brand span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #saaridge-chrome .os-badge {
      flex: 1 1 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
      border: 1px solid rgba(61, 186, 138, 0.22);
      background: rgba(61, 186, 138, 0.08);
      color: #8fa79b;
      font-size: 11px;
      min-width: 0;
      max-width: 220px;
      margin: 0 auto;
      -webkit-app-region: no-drag;
      cursor: default;
    }
    #saaridge-chrome .os-badge[hidden] { display: none; }
    #saaridge-chrome .os-badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3dba8a;
      flex-shrink: 0;
    }
    #saaridge-chrome .actions {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      flex: 0 0 auto;
      margin-left: auto;
      -webkit-app-region: no-drag;
    }
    #saaridge-chrome .actions button {
      appearance: none;
      border: 1px solid #24302b;
      background: #1a2420;
      color: #e7f0eb;
      border-radius: 8px;
      padding: 0.32rem 0.65rem;
      font: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex-shrink: 0;
      min-height: 28px;
      pointer-events: auto;
    }
    #saaridge-chrome .actions button:hover { border-color: #3dba8a; }
    #saaridge-chrome .actions button svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: block;
      stroke: #e7f0eb;
    }
    @media (max-width: 520px) {
      #saaridge-chrome { padding-left: 12px; }
      #saaridge-chrome .brand span { display: none; }
      #saaridge-chrome .os-badge { display: none !important; }
    }
  `;
  document.head.appendChild(style);

  const chrome = document.createElement("header");
  chrome.id = "saaridge-chrome";
  chrome.innerHTML = `
    <div class="brand">
      <div class="mark" aria-hidden="true"></div>
      <span>Saaridge</span>
    </div>
    <div class="os-badge" id="saaridgeOsBadge" hidden>
      <span class="dot" aria-hidden="true"></span>
      <span id="saaridgeOsLabel">Linux</span>
    </div>
    <div class="actions">
      <button type="button" id="saaridgeBtnSettings" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        <span>Settings</span>
      </button>
    </div>
  `;
  document.body.insertBefore(chrome, document.body.firstChild);

  if (window.saaridge?.platform && window.saaridge.platform !== "darwin") {
    chrome.style.paddingLeft = "12px";
  }

  const btn = document.getElementById("saaridgeBtnSettings");
  btn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void window.saaridge?.openSettings?.("policies");
  });

  chrome.addEventListener("pointerup", (ev) => {
    if (ev.target.closest("button")) return;
    void window.saaridge?.focusDesktop?.();
  });

  (async () => {
    try {
      const control =
        (await window.saaridge?.getUrls?.())?.control ||
        "http://127.0.0.1:3847";
      const r = await fetch(`${control}/api/workspace/os`);
      const j = await r.json();
      if (j?.os) {
        const badge = document.getElementById("saaridgeOsBadge");
        const label = document.getElementById("saaridgeOsLabel");
        if (label) label.textContent = j.os.label || "Linux";
        if (badge) {
          badge.title = j.os.detail || "Sandbox desktop OS";
          badge.hidden = false;
        }
      }
    } catch (_) {}
  })();

  return true;
})();
