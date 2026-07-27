import { dockerExec, containerRunning } from "./docker.js";
import { logStep } from "./logger.js";

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const safeDesktopName = (name) =>
  String(name)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "Assistant";

/**
 * Agent “card” page lives under ~/.local/share — not on the Desktop.
 * Workspace Desktop stays browser-only at startup.
 */
export const installAgentDesktopIcon = async (agent) => {
  if (!(await containerRunning())) return { ok: false };

  const title = safeDesktopName(agent.name || "Assistant");
  const htmlDir = `/home/browser/.local/share/onebridge/agents`;
  const htmlFile = `${htmlDir}/${agent.id}.html`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f7f5; color: #14201c; }
    main { max-width: 520px; margin: 48px auto; padding: 28px; background: white; border-radius: 18px;
      box-shadow: 0 18px 40px rgba(20,32,28,.08); border: 1px solid #d7e0db; }
    h1 { font-size: 1.5rem; margin: 0 0 8px; }
    p { color: #3d4f47; line-height: 1.5; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #d8f0e7; color: #0a5a46; font-size: 12px; font-weight: 700; }
    code { font-size: 12px; background: #eef3f0; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <div class="pill">Assistant</div>
    <h1>${escapeHtml(title)}</h1>
    <p>This assistant is installed in your secure OneBridge workspace. It can only reach your computer through the bridge.</p>
    <p>ID: <code>${escapeHtml(agent.id)}</code></p>
    <p>Status: <strong>${escapeHtml(agent.status || "running")}</strong></p>
  </main>
</body>
</html>`;

  const script = `
mkdir -p ${JSON.stringify(htmlDir)}
# Keep Desktop clean — leave Install Assistant launcher alone
find /home/browser/Desktop -mindepth 1 -maxdepth 1 ! -name 'Install Assistant.desktop' -exec rm -rf {} + 2>/dev/null || true
cat > ${JSON.stringify(htmlFile)} <<'HTML_EOF'
${html}
HTML_EOF
chown -R browser:browser /home/browser/.local/share/onebridge
`;

  const res = await dockerExec(["bash", "-lc", script]);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || res.stdout };
  }
  try {
    const { ensureInstallAssistantLauncher } = await import("./desktop-launchers.js");
    await ensureInstallAssistantLauncher();
  } catch {
    /* non-fatal */
  }
  logStep("Recorded assistant page (no agent desktop icon)", {
    name: title,
    agentId: agent.id,
  });
  return { ok: true };
};

export const removeAgentDesktopIcon = async (agent) => {
  if (!(await containerRunning()) || !agent) return { ok: true };
  const title = safeDesktopName(agent.name || "Assistant");
  await dockerExec([
    "bash",
    "-lc",
    `rm -f ${JSON.stringify(`/home/browser/Desktop/${title}.desktop`)} ${JSON.stringify(`/home/browser/.local/share/onebridge/agents/${agent.id}.html`)}; chown -R browser:browser /home/browser/Desktop 2>/dev/null || true`,
  ]);
  return { ok: true };
};
