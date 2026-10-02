/**
 * Headless-ish probe: load the real desktop/settings.html, click a Redact radio,
 * and report every console message, uncaught exception, and renderer crash.
 *
 * Standalone Electron main — does NOT start the host stack or touch the running app.
 * Run: desktop/node_modules/.bin/electron scripts/probe-settings-redact.cjs
 */
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const DESKTOP = path.join(__dirname, "..", "desktop");
const CONTROL = "http://127.0.0.1:3847";
const TARGET = process.env.PROBE_ALGO || "protect-personal-data";
const TARGET_MODE = process.env.PROBE_MODE || "redact";

const log = (...a) => console.log("[probe]", ...a);

// settings.js calls these through the real preload bridge.
ipcMain.handle("saaridge:urls", () => ({ control: CONTROL, desktop: "" }));
ipcMain.handle("saaridge:mic-prefs-get", () => ({ shareMic: false }));
ipcMain.handle("saaridge:mic-prefs-set", () => ({ shareMic: false }));

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 740,
    show: false,
    webPreferences: {
      preload: path.join(DESKTOP, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wc = win.webContents;
  wc.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["LOG", "WARN", "ERROR", "DEBUG"][level] || level;
    log(`console[${tag}] ${message}  (${sourceId}:${line})`);
  });
  wc.on("render-process-gone", (_e, details) => {
    log("RENDERER GONE:", JSON.stringify(details));
  });
  wc.on("unresponsive", () => log("WINDOW UNRESPONSIVE"));
  wc.on("preload-error", (_e, p, err) => log("PRELOAD ERROR", p, err?.message));
  wc.on("did-fail-load", (_e, code, desc) => log("DID FAIL LOAD", code, desc));

  await wc.loadFile(path.join(DESKTOP, "settings.html"), {
    query: { pane: "policies" },
  });

  // Surface uncaught errors + unhandled rejections from the page itself.
  await wc.executeJavaScript(`
    window.__probeErrors = [];
    window.addEventListener("error", (e) => {
      window.__probeErrors.push("error: " + (e.message || "") + " @ " +
        (e.filename || "") + ":" + (e.lineno || "") +
        (e.error && e.error.stack ? "\\n" + e.error.stack : ""));
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      window.__probeErrors.push("unhandledrejection: " +
        ((r && (r.stack || r.message)) || String(r)));
    });
    true;
  `);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(2500); // let reloadPolicies() finish

  const before = await wc.executeJavaScript(`(() => {
    const root = document.getElementById("globalRows");
    return {
      cards: root ? root.querySelectorAll(".policy-card").length : -1,
      rootHtmlLen: root ? root.innerHTML.length : -1,
      bodyTextLen: document.body.innerText.length,
      status: (document.getElementById("policyStatus") || {}).textContent,
      meta: (document.getElementById("policyMeta") || {}).textContent,
      radios: document.querySelectorAll('input[type=radio]').length,
      errors: window.__probeErrors.slice(),
    };
  })()`);
  log("BEFORE:", JSON.stringify(before, null, 2));

  const snapshot = async (label) => {
    const s = await wc.executeJavaScript(`(() => {
      const root = document.getElementById("globalRows");
      const pane = document.getElementById("pane-policies");
      return {
        cards: root ? root.querySelectorAll(".policy-card").length : -1,
        rootHtmlLen: root ? root.innerHTML.length : -1,
        bodyTextLen: document.body.innerText.length,
        status: (document.getElementById("policyStatus") || {}).textContent,
        paneHidden: pane ? pane.hidden : "no-pane",
        modeBadges: [...document.querySelectorAll(".policy-badge.mode")]
          .map((e) => e.textContent),
        errors: window.__probeErrors.slice(),
      };
    })()`);
    log(label, JSON.stringify(s, null, 2));
    return s;
  };

  // Restore whatever the policy was set to, so probing never changes real settings.
  const originalMode = await wc.executeJavaScript(`(() => {
    const on = document.querySelector('input[name="mode-${TARGET}"]:checked');
    return on ? on.value : null;
  })()`);
  log("original mode:", originalMode);

  // A real user transition fires "change": move away from the current mode, then back.
  for (const mode of ["allow", "block", "redact"]) {
    const clicked = await wc.executeJavaScript(`(() => {
      const sel = 'input[name="mode-${TARGET}"][value="${mode}"]';
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: "radio not found: " + sel };
      const was = el.checked;
      el.scrollIntoView();
      el.click();
      return { ok: true, was, nowChecked: el.checked, disabled: el.disabled };
    })()`);
    log(`CLICK ${mode}:`, JSON.stringify(clicked));
    await sleep(1500);
    await snapshot(`AFTER ${mode}:`);
  }

  if (originalMode && originalMode !== TARGET_MODE) {
    await fetch(`${CONTROL}/api/policies/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ algorithmId: TARGET, mode: originalMode }),
    }).catch(() => {});
    log("restored mode to", originalMode);
  }

  app.exit(0);
});
