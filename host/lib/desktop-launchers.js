import { dockerExec, containerRunning } from "./docker.js";
import { logStep } from "./logger.js";

const INSTALL_DESKTOP_NAME = "Install Assistant.desktop";

/**
 * Desktop launcher: zenity file picker → install selected package.
 */
export const ensureInstallAssistantLauncher = async () => {
  if (!(await containerRunning())) return { ok: false };

  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/.local/share/applications"

cat > "$HOME/.local/share/applications/onebridge-install-assistant.desktop" <<'EOF'
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
chmod +x "$HOME/.local/share/applications/onebridge-install-assistant.desktop"

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

export const clearDesktopKeepInstall = async () => {
  if (!(await containerRunning())) return { ok: false };
  // Keep Install Assistant + any OneBridge-installed app icons.
  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop"
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do
  base="$(basename "$entry")"
  [[ "$base" == ${JSON.stringify(INSTALL_DESKTOP_NAME)} ]] && continue
  [[ "$base" == "Install-Assistant.sh" ]] && continue
  if [[ -f "$entry" && "$entry" == *.desktop ]] && grep -q '^X-OneBridge-Package=' "$entry" 2>/dev/null; then
    continue
  fi
  rm -rf "$entry"
done
`;
  await dockerExec(["bash", "-lc", script], { user: "browser" });
  return ensureInstallAssistantLauncher();
};

/** Copy OneBridge-installed app launchers back onto the Desktop. */
export const restoreInstalledAppIcons = async () => {
  if (!(await containerRunning())) return { ok: false };
  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop"
for app in "$HOME"/.local/share/applications/onebridge-*.desktop; do
  [[ -f "$app" ]] || continue
  case "$(basename "$app")" in
    onebridge-install-assistant.desktop|onebridge-browser.desktop) continue ;;
  esac
  grep -q '^X-OneBridge-Package=' "$app" 2>/dev/null || continue
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
