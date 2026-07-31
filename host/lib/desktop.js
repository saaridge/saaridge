import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getAgents, saveAgents } from "./state.js";
import { dockerCp, dockerExec, containerRunning } from "./docker.js";
import { logStep, logError } from "./logger.js";
import { ROOT, CONTAINER_NAME } from "./paths.js";
import { clearDesktopKeepInstall, restoreInstalledAppIcons } from "./desktop-launchers.js";
import { defaultDataPolicy } from "../bridge/data/policy.js";
import { provisionOneBridgeRoots } from "./auth.js";

export const DESKTOP_AGENT_ID = "workspace-desktop";
export const DESKTOP_PROXY_PORT = 17999;

/** Short host label for Places / Desktop (e.g. Mohits-Mac-mini). */
export const hostDisplayName = () =>
  String(os.hostname() || "Host")
    .replace(/\.local$/i, "")
    .split(".")[0] || "Host";

/** Persistent bridge identity for the interactive desktop browser user. */
export const ensureDesktopCredential = () => {
  const state = getAgents();
  state.agents = state.agents || [];
  let agent = state.agents.find((a) => a.id === DESKTOP_AGENT_ID);
  const roots = provisionOneBridgeRoots(DESKTOP_AGENT_ID);
  if (!agent) {
    agent = {
      id: DESKTOP_AGENT_ID,
      name: "Workspace Desktop",
      username: "browser",
      uid: null,
      token: crypto.randomBytes(32).toString("hex"),
      localProxyPort: DESKTOP_PROXY_PORT,
      kind: "desktop",
      policy: defaultDataPolicy(DESKTOP_AGENT_ID),
      hostWorkspace: roots.workspace,
      status: "desktop",
      installedAt: new Date().toISOString(),
    };
    state.agents.push(agent);
    saveAgents(state);
    logStep("Created workspace desktop bridge identity");
  } else {
    let dirty = false;
    if (!agent.policy?.paths?.length) {
      agent.policy = { ...defaultDataPolicy(DESKTOP_AGENT_ID), ...agent.policy };
      agent.policy.paths = defaultDataPolicy(DESKTOP_AGENT_ID).paths;
      agent.policy.pathsReadOnly =
        agent.policy.pathsReadOnly || defaultDataPolicy(DESKTOP_AGENT_ID).pathsReadOnly;
      dirty = true;
    }
    // Ensure host home is listed as RO in stored policy (effectiveRoots also injects it).
    // Do not clear hostHomeWrite if the host user already granted write.
    const ro = Array.isArray(agent.policy?.pathsReadOnly)
      ? [...agent.policy.pathsReadOnly]
      : [];
    if (!ro.includes("~")) {
      agent.policy = { ...agent.policy, pathsReadOnly: [...ro, "~"] };
      dirty = true;
    }
    if (typeof agent.policy.hostHomeWrite !== "boolean") {
      agent.policy = { ...agent.policy, hostHomeWrite: false, hostHomeWriteAt: null };
      dirty = true;
    }
    if (!agent.hostWorkspace) {
      agent.hostWorkspace = roots.workspace;
      dirty = true;
    }
    if (dirty) saveAgents(state);
  }
  if (!agent.localProxyPort) {
    agent.localProxyPort = DESKTOP_PROXY_PORT;
    saveAgents(state);
  }
  return agent;
};

/**
 * Sync desktop credentials into the container and start auth-proxy + Chromium
 * so the noVNC session is always a usable desktop with a browser.
 */
export const provisionDesktopSession = async () => {
  if (!(await containerRunning())) {
    return { ok: false, error: "Container not running" };
  }

  const agent = ensureDesktopCredential();

  const uidRes = await dockerExec(["bash", "-lc", "id -u browser"]);
  const uid = Number((uidRes.stdout || "").trim());
  if (!Number.isFinite(uid)) {
    logError("Could not resolve browser UID in container");
    return { ok: false, error: "browser user missing" };
  }

  const state = getAgents();
  const idx = state.agents.findIndex((a) => a.id === DESKTOP_AGENT_ID);
  if (idx >= 0) {
    state.agents[idx] = {
      ...state.agents[idx],
      uid,
      username: "browser",
      containerPath: "/home/browser",
      status: "desktop",
    };
    saveAgents(state);
  }
  agent.uid = uid;

  const hostName = hostDisplayName();
  const cred = {
    agentId: agent.id,
    token: agent.token,
    localProxyPort: agent.localProxyPort,
    bridgeUrl: "http://host.docker.internal:7331",
    bridgeProxy: "http://host.docker.internal:7332",
    hostMount: "/host",
    hostWorkspace: `/host/workspaces/${agent.id}`,
    hostShared: "/host/shared",
    hostHome: "/host/home",
    hostHostname: hostName,
  };

  const hostCred = path.join(ROOT, "state", ".desktop-cred.json");
  fs.writeFileSync(hostCred, JSON.stringify(cred, null, 2), { mode: 0o600 });

  await dockerExec([
    "bash",
    "-lc",
    "mkdir -p /home/browser /var/run/bridge /opt/bridge && chown -R browser:browser /home/browser",
  ]);

  // Keep bridge helpers current
  for (const file of [
    "auth-proxy.mjs",
    "audio-stream.mjs",
    "agent-env.sh",
    "bridge-browser.sh",
    "bridge-mcp-stdio.mjs",
    "launch-browser.sh",
    "open-agent.sh",
    "open-install-assistant.sh",
    "gtk-file-picker.py",
    "repair-desktop.sh",
    "dedupe-xfce-panel.sh",
    "ensure-x-modes.sh",
    "resize-display.sh",
    "fix-vnc-stack.py",
    "chromium-force-proxy.sh",
    "fit-windows.sh",
    "upgrade-xvfb-max.sh",
    "key-pump.sh",
    "mouse-pump.sh",
    "hostfs-fuse.py",
    "hostfs-watchdog.sh",
    "audio-watchdog.sh",
    "restart-browser.sh",
    "ensure-desktop-icon.py",
  ]) {
    await dockerCp(
      path.join(ROOT, "container", file),
      `${CONTAINER_NAME}:/opt/bridge/${file}`,
    );
  }
  await dockerExec(["mkdir", "-p", "/opt/bridge/host-bin"]);
  for (const file of ["curl", "wget", "bridge-call"]) {
    await dockerCp(
      path.join(ROOT, "container", "host-bin", file),
      `${CONTAINER_NAME}:/opt/bridge/host-bin/${file}`,
    );
  }
  await dockerCp(
    path.join(ROOT, "container", "start-desktop.sh"),
    `${CONTAINER_NAME}:/usr/local/bin/start-desktop.sh`,
  );
  await dockerCp(
    path.join(ROOT, "container", "start-audio.sh"),
    `${CONTAINER_NAME}:/usr/local/bin/start-audio.sh`,
  );
  await dockerCp(
    path.join(ROOT, "container", "entrypoint.sh"),
    `${CONTAINER_NAME}:/usr/local/bin/entrypoint.sh`,
  );
  // dockerCp from macOS often drops +x — fix before any start-desktop / browser launch.
  await dockerExec([
    "bash",
    "-lc",
    [
      "chmod 755 /usr/local/bin/start-desktop.sh /usr/local/bin/start-audio.sh /usr/local/bin/entrypoint.sh",
      "chmod 755 /opt/bridge/*.sh /opt/bridge/host-bin/* 2>/dev/null || true",
      "chmod 755 /opt/bridge/gtk-file-picker.py /opt/bridge/hostfs-fuse.py /opt/bridge/ensure-desktop-icon.py 2>/dev/null || true",
    ].join("; "),
  ]);
  await dockerExec([
    "bash",
    "-lc",
    [
            "chmod 755 /opt/bridge/bridge-browser.sh /opt/bridge/launch-browser.sh /opt/bridge/restart-browser.sh /opt/bridge/open-agent.sh /opt/bridge/open-install-assistant.sh /opt/bridge/gtk-file-picker.py /opt/bridge/repair-desktop.sh /opt/bridge/dedupe-xfce-panel.sh /opt/bridge/ensure-x-modes.sh /opt/bridge/resize-display.sh /opt/bridge/fit-windows.sh /opt/bridge/fix-vnc-stack.py /opt/bridge/key-pump.sh /opt/bridge/mouse-pump.sh /opt/bridge/agent-env.sh /opt/bridge/hostfs-fuse.py /opt/bridge/hostfs-watchdog.sh /opt/bridge/audio-watchdog.sh /opt/bridge/ensure-desktop-icon.py /opt/bridge/host-bin/* /usr/local/bin/start-desktop.sh /usr/local/bin/start-audio.sh /usr/local/bin/entrypoint.sh",
      "chmod 644 /opt/bridge/*.mjs 2>/dev/null || true",
      "mkdir -p /host",
      // Keep RANDR modes available so viewer resize maps 1:1 (accurate clicks).
      "DISPLAY=:1 /opt/bridge/ensure-x-modes.sh >/tmp/ensure-x-modes.log 2>&1 || true",
      // Route /usr/bin/chromium through the bridge proxy (direct Chromium has no net).
      "if [[ -f /opt/bridge/chromium-force-proxy.sh ]]; then " +
        "cp /opt/bridge/chromium-force-proxy.sh /usr/local/bin/chromium-force-proxy.sh; " +
        "chmod 755 /usr/local/bin/chromium-force-proxy.sh /opt/bridge/chromium-force-proxy.sh; " +
        "if [[ -f /usr/bin/chromium && ! -f /usr/bin/chromium.real ]]; then " +
        "cp -a /usr/bin/chromium /usr/bin/chromium.real; fi; " +
        "printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/chromium-force-proxy.sh \"$@\"' > /usr/bin/chromium; " +
        "chmod 755 /usr/bin/chromium; fi",
      // Host data plane FUSE mount (/host → OneBridge + /host/home → host homedir).
      // Always remount so updated hostfs-fuse.py (statfs/uid) takes effect.
      "pkill -f hostfs-watchdog.sh 2>/dev/null || true; " +
        "pkill -f '/opt/bridge/hostfs-fuse.py' 2>/dev/null || true; " +
        "fusermount3 -uz /host 2>/dev/null || umount -l /host 2>/dev/null || true; " +
        "BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials " +
        "BRIDGE_URL=http://host.docker.internal:7331 " +
        "HOSTFS_UID=$(id -u browser) HOSTFS_GID=$(id -g browser) " +
        "nohup /opt/bridge/hostfs-watchdog.sh >/tmp/hostfs-watchdog.log 2>&1 &",
      // Wait briefly then recreate host-home link + Places bookmark only.
      `HOST_LABEL=${JSON.stringify(hostName)}; ` +
        "for i in $(seq 1 40); do " +
        "[[ -d /host/home ]] && break; sleep 0.25; done; " +
        "rm -f /home/browser/Projects /home/browser/Host\\ Home /home/browser/host-home " +
        "'/home/browser/Desktop/Host Projects' '/home/browser/Desktop/Host-Projects' 2>/dev/null || true; " +
        'ln -sfn /host/home "/home/browser/${HOST_LABEL} Home" 2>/dev/null || true; ' +
        'ln -sfn /host/home "/home/browser/Desktop/${HOST_LABEL} Home" 2>/dev/null || true; ' +
        "mkdir -p /home/browser/.config/gtk-3.0; " +
        'printf "%s\\n" "file:///host/home ${HOST_LABEL} Home" ' +
        "> /home/browser/.config/gtk-3.0/bookmarks; " +
        "chown -R browser:browser /home/browser/.config/gtk-3.0 " +
        '"/home/browser/${HOST_LABEL} Home" ' +
        '"/home/browser/Desktop/${HOST_LABEL} Home" 2>/dev/null || true',
    ].join("; "),
  ]);
  await dockerCp(
    path.join(ROOT, "container", "novnc-onebridge.html"),
    `${CONTAINER_NAME}:/usr/share/novnc/novnc-onebridge.html`,
  );

  // Trust MITM CA inside the container so HTTPS shows as secure
  try {
    const { ensureMitmCa } = await import("./mitm-certs.js");
    const { certPath } = ensureMitmCa();
    await dockerExec([
      "bash",
      "-lc",
      "mkdir -p /opt/bridge/certs && chmod 755 /opt/bridge/certs",
    ]);
    await dockerCp(certPath, `${CONTAINER_NAME}:/opt/bridge/certs/onebridge-mitm-ca.crt`);
    await dockerCp(
      path.join(ROOT, "container", "trust-mitm-ca.sh"),
      `${CONTAINER_NAME}:/usr/local/bin/trust-mitm-ca.sh`,
    );
    await dockerExec([
      "bash",
      "-lc",
      "chmod 755 /usr/local/bin/trust-mitm-ca.sh && /usr/local/bin/trust-mitm-ca.sh /opt/bridge/certs/onebridge-mitm-ca.crt",
    ]);
  } catch (err) {
    logError("Could not install MITM CA in container", {
      detail: String(err?.message || err),
    });
  }

  await dockerCp(hostCred, `${CONTAINER_NAME}:/home/browser/.bridge-credentials`);
  fs.unlinkSync(hostCred);

  await dockerExec([
    "bash",
    "-lc",
    [
      "chown browser:browser /home/browser/.bridge-credentials",
      "chmod 600 /home/browser/.bridge-credentials",
      `echo ${agent.localProxyPort} > /var/run/bridge/active-proxy-port`,
      "chmod 644 /var/run/bridge/active-proxy-port",
    ].join(" && "),
  ]);

  // Keep auth-proxy up, but do not kill the user's browser or whole desktop.
  const proxyUp = await dockerExec([
    "bash",
    "-lc",
    `ss -lnt | grep -q ':${agent.localProxyPort} ' && echo UP || echo DOWN`,
  ]);
  if (!(proxyUp.stdout || "").includes("UP")) {
    await dockerExec(
      [
        "bash",
        "-lc",
        [
          "export HOME=/home/browser",
          "export DISPLAY=:1",
          "export AGENT_ID=workspace-desktop",
          "export BRIDGE_PROXY_HOST=host.docker.internal",
          "export BRIDGE_PROXY_PORT=7332",
          "export HOSTFS_IPC_PORT=7333",
          "export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials",
          `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
          // Pass token from host state — avoids nested-quote breakage inside the container.
          `export BRIDGE_TOKEN=${JSON.stringify(agent.token)}`,
          "nohup node /opt/bridge/auth-proxy.mjs > /tmp/desktop-auth-proxy.log 2>&1 &",
        ].join("\n"),
      ],
      { user: "browser" },
    );
  }

  const desktopUp = await dockerExec([
    "bash",
    "-lc",
    `for pid in $(pgrep -u browser -x xfce4-session || true); do
       st=$(ps -o state= -p "$pid" 2>/dev/null | tr -d ' ')
       if [ -n "$st" ] && [ "$st" != "Z" ]; then echo UP; exit 0; fi
     done
     echo DOWN`,
  ]);
  if (!(desktopUp.stdout || "").includes("UP")) {
    await dockerExec([
      "bash",
      "-lc",
      [
        // Tear down any raced sessions/panels before a clean start.
        "pkill -u browser -f '/usr/local/bin/start-desktop.sh' || true",
        "pkill -u browser -x xfce4-session || true",
        "pkill -u browser -x xfce4-panel || true",
        "pkill -u browser -f '/xfce4/panel/wrapper' || true",
        "rm -f /home/browser/.config/onebridge-browser-opened-this-session",
        "rm -f /tmp/onebridge-start-desktop.lock /tmp/onebridge-start-desktop.pid",
        "sleep 0.5",
      ].join("; "),
    ]);
    const start = await dockerExec(
      [
        "bash",
        "-lc",
        [
          "export HOME=/home/browser",
          "export DISPLAY=:1",
          "export AGENT_ID=workspace-desktop",
          "export BRIDGE_URL=http://host.docker.internal:7331",
          "export BRIDGE_PROXY_HOST=host.docker.internal",
          "export BRIDGE_PROXY_PORT=7332",
          "export HOSTFS_IPC_PORT=7333",
          "export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials",
          `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
          `export BRIDGE_TOKEN=${JSON.stringify(agent.token)}`,
          "source /opt/bridge/agent-env.sh",
          "export BROWSER=/opt/bridge/launch-browser.sh",
          "nohup /usr/local/bin/start-desktop.sh > /tmp/desktop.log 2>&1 &",
          "echo started",
        ].join("\n"),
      ],
      { user: "browser" },
    );
    if (start.code !== 0) {
      logError("Failed to start desktop session", {
        detail: start.stderr || start.stdout,
      });
      return { ok: false, error: start.stderr || start.stdout };
    }
    // Fresh session: leave the desktop empty (no browser / file manager).
    await closeDesktopAppWindows();
  } else {
    // Desktop already running — refresh launchers without wiping Install Assistant
    await dockerExec(
      [
        "bash",
        "-lc",
        [
          "export HOME=/home/browser DISPLAY=:1",
          "export XDG_RUNTIME_DIR=/tmp/runtime-browser",
          "pkill -u browser -f xfce4-terminal || true",
          "pkill -u browser -f 'xterm' || true",
          "mkdir -p \"$HOME/Desktop\" \"$HOME/.local/share/applications\"",
          "chmod 755 /opt/bridge/launch-browser.sh /opt/bridge/bridge-browser.sh 2>/dev/null || true",
          "cat > \"$HOME/.local/share/applications/onebridge-browser.desktop\" <<'EOF'",
          "[Desktop Entry]",
          "Version=1.0",
          "Type=Application",
          "Name=Web Browser",
          "Comment=Browse the internet via OneBridge proxy",
          "Exec=/opt/bridge/launch-browser.sh %u",
          "Icon=web-browser",
          "Terminal=false",
          "Categories=Network;WebBrowser;",
          "StartupNotify=true",
          "EOF",
          "chmod +x \"$HOME/.local/share/applications/onebridge-browser.desktop\"",
          "cp -f \"$HOME/.local/share/applications/onebridge-browser.desktop\" \"$HOME/Desktop/Web Browser.desktop\"",
          "chmod +x \"$HOME/Desktop/Web Browser.desktop\"",
          "gio set \"$HOME/Desktop/Web Browser.desktop\" metadata::trusted true 2>/dev/null || true",
          "find \"$HOME/Desktop\" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do",
          "  base=\"$(basename \"$entry\")\"",
          "  [[ \"$base\" == 'Install Assistant.desktop' ]] && continue",
          "  [[ \"$base\" == 'Web Browser.desktop' ]] && continue",
          "  if [[ -f \"$entry\" && \"$entry\" == *.desktop ]] && grep -q '^X-OneBridge-Package=' \"$entry\" 2>/dev/null; then continue; fi",
          "  rm -rf \"$entry\"",
          "done",
          "xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-home -n -t bool -s false 2>/dev/null || xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-home -s false 2>/dev/null || true",
          "xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-trash -n -t bool -s false 2>/dev/null || xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-trash -s false 2>/dev/null || true",
          "xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-filesystem -n -t bool -s false 2>/dev/null || xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-filesystem -s false 2>/dev/null || true",
          "xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-removable -n -t bool -s false 2>/dev/null || xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-removable -s false 2>/dev/null || true",
        ].join("\n"),
      ],
      { user: "browser" },
    );
  }

  await clearDesktopKeepInstall();
  await restoreInstalledAppIcons();

  // Let start-desktop.sh finish starting xfce4-session before repair runs
  // (repair used to spawn a stray panel and steal the notification area).
  await new Promise((r) => setTimeout(r, 5000));

  // Heal window manager if it died (otherwise windows cannot be closed).
  await dockerExec(
    [
      "bash",
      "-lc",
      "export DISPLAY=:1 HOME=/home/browser XDG_RUNTIME_DIR=/tmp/runtime-browser; /opt/bridge/repair-desktop.sh >/tmp/repair-desktop.out 2>&1 || true; /opt/bridge/dedupe-xfce-panel.sh >/tmp/dedupe-panel.out 2>&1 || true",
    ],
    { user: "browser" },
  );

  // Pulse + audio-stream, then a watchdog so they stay up across crashes.
  const audio = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "export HOME=/home/browser",
        "export DISPLAY=:1",
        "export XDG_RUNTIME_DIR=/tmp/runtime-browser",
        "export PULSE_RUNTIME_PATH=/tmp/runtime-browser/pulse",
        "chmod 755 /usr/local/bin/start-audio.sh /opt/bridge/audio-watchdog.sh 2>/dev/null || true",
        "/usr/local/bin/start-audio.sh >/tmp/start-audio.log 2>&1",
        "echo AUDIO_EXIT:$?",
        "tail -20 /tmp/start-audio.log || true",
        // Stop prior watchdog via pidfile only (pkill -f matches this -c string).
        "if [[ -f /tmp/audio-watchdog.pid ]]; then kill \"$(cat /tmp/audio-watchdog.pid)\" 2>/dev/null || true; rm -f /tmp/audio-watchdog.pid /tmp/audio-watchdog.lock; fi",
        "sleep 0.2",
        "setsid /opt/bridge/audio-watchdog.sh </dev/null >/tmp/audio-watchdog.log 2>&1 &",
        "echo AUDIO_WATCHDOG:$!",
      ].join("\n"),
    ],
    { user: "browser" },
  );
  if (!(audio.stdout || "").includes("OK pulse") && !(audio.stdout || "").includes("OK already")) {
    logError("Audio stream failed to start", {
      detail: (audio.stdout || "") + (audio.stderr || ""),
    });
  } else {
    logStep("Audio pulse + watchdog running");
  }

  // Do not place agent/demo icons on the desktop at startup — Install Assistant only.

  logStep("Workspace desktop is ready");
  return { ok: true, agentId: DESKTOP_AGENT_ID };
};

/** Close user-facing app windows so the desktop starts empty. */
const closeDesktopAppWindows = async () => {
  await dockerExec(
    [
      "bash",
      "-lc",
      [
        "export DISPLAY=:1 HOME=/home/browser",
        // Close browsers / file managers / install windows — keep the desktop itself
        "pkill -u browser -x chromium 2>/dev/null || true",
        "pkill -u browser -f '/usr/lib/chromium/chromium' 2>/dev/null || true",
        "pkill -u browser -x thunar 2>/dev/null || true",
        "pkill -u browser -f 'thunar' 2>/dev/null || true",
        "rm -f /home/browser/chromium-bridge-profile/SingletonLock /home/browser/chromium-bridge-profile/SingletonCookie /home/browser/chromium-bridge-profile/SingletonSocket 2>/dev/null || true",
        "rm -f /home/browser/chromium-install-profile/SingletonLock /home/browser/chromium-install-profile/SingletonCookie /home/browser/chromium-install-profile/SingletonSocket 2>/dev/null || true",
        "rm -f /home/browser/.config/onebridge-browser-opened-this-session 2>/dev/null || true",
        "sleep 0.3",
        "echo CLOSED",
      ].join("\n"),
    ],
    { user: "browser" },
  );
  logStep("Desktop app windows closed (empty desktop)");
  return { ok: true };
};

/** Open Chromium on demand only (not at desktop boot). */
export const ensureWorkspaceBrowserOpen = async (agent) => {
  const check = await dockerExec(
    [
      "bash",
      "-lc",
      // Only count the main browser profile — not Install Assistant
      `pgrep -u browser -f 'chromium-bridge-profile' >/dev/null && echo UP || echo DOWN`,
    ],
    { user: "browser" },
  );
  if ((check.stdout || "").includes("UP")) {
    return { ok: true, already: true };
  }

  logStep("Launching workspace browser on demand");
  const launch = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "export HOME=/home/browser",
        "export DISPLAY=:1",
        "export XDG_RUNTIME_DIR=/tmp/runtime-browser",
        "export PULSE_RUNTIME_PATH=/tmp/runtime-browser/pulse",
        "export PULSE_SERVER=unix:/tmp/runtime-browser/pulse/native",
        "export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials",
        `export LOCAL_PROXY_PORT=${agent.localProxyPort}`,
        "if [[ ! -f /home/browser/.bridge-credentials ]]; then echo MISSING_CREDS; exit 2; fi",
        `for i in $(seq 1 30); do ss -lnt 2>/dev/null | grep -q ':${agent.localProxyPort} ' && break; sleep 0.2; done`,
        "/usr/local/bin/start-audio.sh >/tmp/start-audio-from-browser.log 2>&1 || true",
        "nohup /opt/bridge/launch-browser.sh https://www.google.com >/tmp/chromium-desktop.log 2>&1 &",
        "for i in $(seq 1 30); do pgrep -u browser -f 'chromium-bridge-profile' >/dev/null && echo OPENED && exit 0; sleep 0.2; done",
        "echo FAIL; tail -30 /tmp/chromium-desktop.log 2>/dev/null; exit 1",
      ].join("\n"),
    ],
    { user: "browser", timeoutMs: 25_000 },
  );

  if (!(launch.stdout || "").includes("OPENED")) {
    logError("Failed to open workspace browser", {
      detail: launch.stderr || launch.stdout,
    });
    return { ok: false, error: launch.stderr || launch.stdout };
  }
  return { ok: true, already: false };
};
