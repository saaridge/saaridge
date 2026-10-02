/**
 * Electron main for scripts/test-settings-ui.mjs.
 * Loads the real desktop/settings.html against a stub policy API (never the
 * live host — writes would change real settings), clicks every
 * mode on every policy card, and asserts the window never goes blank.
 * Prints one JSON line prefixed with RESULT: and exits.
 */
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const DESKTOP_DIR =
  process.env.SAARIDGE_DESKTOP_DIR || path.join(__dirname, "..", "..", "desktop");

const cat = (id) => ({ id, label: id, description: "", enabled: true });
const algorithms = [
  "protect-secrets",
  "protect-personal-data",
  "block-payment-data",
  "hide-sensitive-files",
  "stop-data-smuggling",
  "words-i-protect",
].map((id) => ({
  id,
  name: id,
  description: "Stub policy for layout test.",
  enabledGlobally: true,
  mode: "redact",
  allowModes: ["redact", "block", "allow"],
  categories: [cat(`${id}-a`), cat(`${id}-b`), cat(`${id}-c`)],
  supportsKnownValues: id === "words-i-protect",
  knownValues: [],
}));

// settings.html CSP only allows the real control-plane origin, so the stub
// answers that origin inside an isolated session instead of a real port.
const CONTROL = "http://127.0.0.1:3847";

const stubResponse = async (request) => {
  const { pathname } = new URL(request.url);
  const json = (obj) =>
    new Response(JSON.stringify(obj), {
      headers: { "Content-Type": "application/json" },
    });
  if (pathname === "/api/policies/status") return json({ ok: true, configPath: "/stub" });
  if (pathname === "/api/policies/global") return json({ ok: true, algorithms });
  if (pathname === "/api/policies/agents") return json({ ok: true, agents: [] });
  if (pathname === "/api/policies/mode") {
    const { algorithmId, mode } = JSON.parse((await request.text()) || "{}");
    const algo = algorithms.find((a) => a.id === algorithmId);
    if (algo) algo.mode = mode;
    return json({ ok: true, algorithms });
  }
  return json({ ok: true });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const finish = (result) => {
  console.log(`RESULT:${JSON.stringify(result)}`);
  app.exit(0);
};

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  const ses = session.fromPartition("saaridge-settings-ui-test");
  ses.protocol.handle("http", (request) =>
    request.url.startsWith(`${CONTROL}/`)
      ? stubResponse(request)
      : new Response("blocked in test", { status: 404 }),
  );
  ipcMain.handle("saaridge:urls", () => ({ control: CONTROL, desktop: "" }));
  ipcMain.handle("saaridge:mic-prefs-get", () => ({ shareMic: false }));
  ipcMain.handle("saaridge:mic-prefs-set", () => ({ shareMic: false }));

  const failures = [];
  const timer = setTimeout(
    () => finish({ ok: false, failures: [...failures, "timed out"] }),
    60_000,
  );

  // Short window so later policy cards start well below the fold.
  const win = new BrowserWindow({
    width: 880,
    height: 560,
    show: true,
    webPreferences: {
      session: ses,
      preload: path.join(DESKTOP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.on("render-process-gone", (_e, d) => failures.push(`renderer gone: ${d.reason}`));
  await wc.loadFile(path.join(DESKTOP_DIR, "settings.html"), {
    query: { pane: "policies" },
  });
  win.focus();

  let cards = 0;
  for (let i = 0; i < 50 && cards < algorithms.length; i++) {
    await sleep(100);
    cards = await wc.executeJavaScript(
      `document.querySelectorAll("#globalRows .policy-card").length`,
    );
  }
  if (cards !== algorithms.length) {
    clearTimeout(timer);
    return finish({ ok: false, failures: [`rendered ${cards} policy cards`] });
  }

  for (const algo of algorithms) {
    for (const mode of ["block", "allow", "redact"]) {
      const r = await wc.executeJavaScript(`(async () => {
        const input = document.querySelector('input[name="mode-${algo.id}"][value="${mode}"]');
        if (!input) return { error: "radio missing" };
        const label = input.closest("label");
        // An unanchored input only drifts from its label once .pane-body scrolls.
        label.scrollIntoView({ block: "center" });
        await new Promise((r) => requestAnimationFrame(r));
        const lr = label.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        const inside =
          ir.top >= lr.top - 1 && ir.bottom <= lr.bottom + 1 &&
          ir.left >= lr.left - 1 && ir.right <= lr.right + 1;
        label.click();
        await new Promise((r) => setTimeout(r, 250));
        const root = document.scrollingElement || document.documentElement;
        return {
          inside,
          rootScroll: root.scrollTop + root.scrollLeft,
          bodyScroll: document.body.scrollTop + document.body.scrollLeft,
          layoutTop: Math.round(document.querySelector(".layout").getBoundingClientRect().top),
          navVisible: document.querySelector("nav").getBoundingClientRect().bottom > 0,
          checked: input.checked,
        };
      })()`);
      const where = `${algo.id}/${mode}`;
      if (r.error) failures.push(`${where}: ${r.error}`);
      else {
        if (!r.inside) failures.push(`${where}: hidden radio laid out outside its label`);
        if (r.rootScroll || r.bodyScroll || r.layoutTop !== 0 || !r.navVisible) {
          failures.push(
            `${where}: page root scrolled (root=${r.rootScroll} body=${r.bodyScroll} layoutTop=${r.layoutTop}) — Settings goes blank`,
          );
        }
        if (!r.checked) failures.push(`${where}: radio not checked after click`);
      }
    }
  }

  clearTimeout(timer);
  finish({ ok: failures.length === 0, failures });
});
