import { dockerExec, containerRunning } from "./docker.js";
import { logStep } from "./logger.js";

const INSTALL_DESKTOP_NAME = "Install Assistant.desktop";

/**
 * Desktop launcher that only opens the Downloads folder.
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
Comment=Open the Downloads folder
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=folder-download
Terminal=false
Categories=Utility;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/onebridge-install-assistant.desktop"

cat > "$HOME/Desktop/${INSTALL_DESKTOP_NAME}" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Link
Name=Install Assistant
Comment=Open the Downloads folder
Icon=folder-download
URL=application://onebridge-install-assistant.desktop
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
  logStep("Install Assistant launcher ready (opens Downloads)");
  return { ok: true };
};

export const clearDesktopKeepInstall = async () => {
  if (!(await containerRunning())) return { ok: false };
  const script = `
export HOME=/home/browser
mkdir -p "$HOME/Desktop"
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 \
  ! -name ${JSON.stringify(INSTALL_DESKTOP_NAME)} \
  ! -name 'Install-Assistant.sh' \
  -exec rm -rf {} +
`;
  await dockerExec(["bash", "-lc", script], { user: "browser" });
  return ensureInstallAssistantLauncher();
};
