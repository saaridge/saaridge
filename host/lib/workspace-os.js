/**
 * Known OS of the sandboxed workspace desktop (container image).
 * Kept in one place so the desktop shell and control plane stay aligned.
 */
export const WORKSPACE_OS = Object.freeze({
  family: "Linux",
  distro: "Debian",
  version: "12",
  codename: "bookworm",
  desktop: "XFCE",
  /** Short label for the title bar */
  label: "Debian 12",
  /** Full string for tooltips / APIs */
  detail: "Linux · Debian 12 (bookworm) · XFCE",
});

export const getWorkspaceOs = () => ({ ...WORKSPACE_OS });
