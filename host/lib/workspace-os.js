/**
 * OS labels for the desktop shell / APIs.
 * Agents must see the **host** OS. The XFCE Linux image is UI-only sandbox.
 */
import { buildHostIdentity } from "./host-identity.js";

/** @deprecated Prefer getWorkspaceOs(); kept for any static imports. */
export const WORKSPACE_OS = Object.freeze({
  family: "Linux",
  distro: "Debian",
  version: "12",
  codename: "bookworm",
  desktop: "XFCE",
  label: "Debian 12",
  detail: "Linux · Debian 12 (bookworm) · XFCE",
});

export const getWorkspaceOs = () => {
  const host = buildHostIdentity("workspace-desktop");
  const isMac = host.platform === "darwin";
  const isWin = host.platform === "win32";
  return {
    family: isMac ? "macOS" : isWin ? "Windows" : "Linux",
    distro: isMac ? "macOS" : isWin ? "Windows" : "Linux",
    version: host.release,
    prettyName: host.prettyName,
    hostname: host.hostname,
    platform: host.platform,
    osType: host.osType,
    arch: host.arch,
    desktop: "XFCE",
    label: isMac
      ? host.prettyName.replace(/^macOS\s+/, "macOS ")
      : host.prettyName,
    detail: `${host.prettyName} · ${host.arch} · mediated desktop`,
    home: host.shell.home,
  };
};
