import { dockerExec, containerRunning } from "./docker.js";
import { logStep } from "./logger.js";

const INSTALL_DESKTOP_NAME = "Install Assistant.desktop";
const BROWSER_DESKTOP_NAME = "Web Browser.desktop";

/**
 * Desktop launcher: zenity file picker → install selected package.
 */
export const ensureInstallAssistantLauncher = async () => {
  if (!(await containerRunning())) return { ok: false };

  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/.local/share/applications"

cat > "$HOME/.local/share/applications/saaridge-install-assistant.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Install Assistant
Comment=Install or uninstall packages
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=/usr/share/icons/Adwaita/48x48/legacy/system-software-install.png
Terminal=false
Categories=Utility;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/saaridge-install-assistant.desktop"

# XFCE desktop icons must be Type=Application with Exec= — Type=Link
# application://… URIs fail with "Operation not supported".
cat > "$HOME/Desktop/${INSTALL_DESKTOP_NAME}" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Install Assistant
Comment=Install or uninstall packages
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=/usr/share/icons/Adwaita/48x48/legacy/system-software-install.png
Terminal=false
Categories=Utility;
StartupNotify=false
EOF
chmod +x "$HOME/Desktop/${INSTALL_DESKTOP_NAME}"

if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/${INSTALL_DESKTOP_NAME}" metadata::trusted true 2>/dev/null || true
fi

chown -R browser:browser "$HOME/Desktop" "$HOME/Downloads" "$HOME/.local/share/applications"
`;

  const res = await dockerExec(["bash", "-lc", script], { user: "browser" });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || res.stdout };
  }
  logStep("Install Assistant launcher ready (file picker)");
  return { ok: true };
};

/** Proxied Chromium launcher (Desktop + apps menu). Mediation unchanged. */
export const ensureBrowserLauncher = async () => {
  if (!(await containerRunning())) return { ok: false };

  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop" "$HOME/.local/share/applications"
# Scripts must be executable (dockerCp from macOS often drops +x).
chmod 755 /opt/bridge/launch-browser.sh /opt/bridge/bridge-browser.sh 2>/dev/null || true

cat > "$HOME/.local/share/applications/saaridge-browser.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Web Browser
Comment=Browse the internet via Saaridge proxy
Exec=/opt/bridge/launch-browser.sh %u
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
EOF
chmod +x "$HOME/.local/share/applications/saaridge-browser.desktop"

cat > "$HOME/Desktop/${BROWSER_DESKTOP_NAME}" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Web Browser
Comment=Browse the internet via Saaridge proxy
Exec=/opt/bridge/launch-browser.sh %u
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
EOF
chmod +x "$HOME/Desktop/${BROWSER_DESKTOP_NAME}"

if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/${BROWSER_DESKTOP_NAME}" metadata::trusted true 2>/dev/null || true
fi
if command -v xdg-settings >/dev/null 2>&1; then
  xdg-settings set default-web-browser saaridge-browser.desktop 2>/dev/null || true
fi
chown -R browser:browser "$HOME/Desktop" "$HOME/.local/share/applications"
`;

  const res = await dockerExec(["bash", "-lc", script], { user: "browser" });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || res.stdout };
  }
  logStep("Web Browser launcher ready (proxied)");
  return { ok: true };
};

export const clearDesktopKeepInstall = async () => {
  if (!(await containerRunning())) return { ok: false };
  // Keep Install Assistant, Web Browser, and Saaridge-installed app icons.
  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop"
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do
  base="$(basename "$entry")"
  [[ "$base" == ${JSON.stringify(INSTALL_DESKTOP_NAME)} ]] && continue
  [[ "$base" == ${JSON.stringify(BROWSER_DESKTOP_NAME)} ]] && continue
  [[ "$base" == "Install-Assistant.sh" ]] && continue
  if [[ -f "$entry" && "$entry" == *.desktop ]] && grep -q '^X-Saaridge-Package=' "$entry" 2>/dev/null; then
    continue
  fi
  rm -rf "$entry"
done
`;
  await dockerExec(["bash", "-lc", script], { user: "browser" });
  await ensureInstallAssistantLauncher();
  return ensureBrowserLauncher();
};

/** Copy Saaridge-installed app launchers back onto the Desktop. */
export const restoreInstalledAppIcons = async () => {
  if (!(await containerRunning())) return { ok: false };
  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop"
for app in "$HOME"/.local/share/applications/saaridge-*.desktop; do
  [[ -f "$app" ]] || continue
  case "$(basename "$app")" in
    saaridge-install-assistant.desktop|saaridge-browser.desktop) continue ;;
  esac
  grep -q '^X-Saaridge-Package=' "$app" 2>/dev/null || continue
  name="$(grep -m1 '^Name=' "$app" | sed 's/^Name=//' || true)"
  [[ -z "$name" ]] && continue
  dest="$HOME/Desktop/\${name}.desktop"
  cp -f "$app" "$dest"
  chmod +x "$dest"
  gio set "$dest" metadata::trusted true 2>/dev/null || true
done
if pgrep -x xfdesktop >/dev/null 2>&1; then
  xfdesktop --reload 2>/dev/null || true
fi
`;
  await dockerExec(["bash", "-lc", script], { user: "browser" });
  return { ok: true };
};
