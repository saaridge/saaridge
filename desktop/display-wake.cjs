"use strict";

/**
 * Decisions for restoring the Saaridge window after macOS lock / display sleep.
 *
 * System sleep and display-off invalidate the SkyLight display id and free the
 * window's IOSurface. Electron then orders the same NSWindow front with an
 * empty layer (a fully blank UI). The in-container VNC stack often stays up,
 * so stream-health stays green and will not reload the viewer on its own.
 *
 * Dark wake emits `resume` while the screen is still locked and the display
 * id is still invalid. Rebuilding the surface at that moment stays blank.
 * Recovery waits until the screen is unlocked and a real display is back.
 */

const MIN_OVERLAP = 80;
const MIN_WINDOW = 200;

const overlap = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w, h };
};

/** True when `bounds` covers a usable region of a live display. */
const windowOnScreen = (bounds, displays) => {
  if (!bounds || bounds.width < MIN_WINDOW || bounds.height < MIN_WINDOW) {
    return false;
  }
  return (displays || []).some((d) => {
    const area = d.bounds || d.workArea;
    if (!area || area.width < 100 || area.height < 100) return false;
    const o = overlap(bounds, area);
    return o.w > MIN_OVERLAP && o.h > MIN_OVERLAP;
  });
};

/**
 * Center a window on `workArea` when its display disappeared during sleep.
 * Returns null when the window is already on a live display at a usable size.
 */
const replacementBounds = (windowBounds, displays, workArea) => {
  if (windowOnScreen(windowBounds, displays)) return null;
  const b = windowBounds || { width: 1440, height: 900 };
  const area = workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const width = Math.min(
    Math.max(b.width || 1440, 960),
    Math.max(320, area.width - 80),
  );
  const height = Math.min(
    Math.max(b.height || 900, 640),
    Math.max(240, area.height - 80),
  );
  return {
    x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
    width,
    height,
  };
};

/** One-pixel growth forces AppKit to allocate a new IOSurface. */
const nudgeSize = (bounds) => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width + 1,
  height: bounds.height,
});

const planDisplayWake = (state) => {
  const recover =
    Boolean(state.surfaceStale) &&
    !state.screenLocked &&
    Boolean(state.hasDisplay);
  if (!recover) {
    return {
      recover: false,
      nudge: false,
      reloadDesktop: false,
      deferDesktopReload: false,
      reloadShell: false,
    };
  }
  const desktopLive = Boolean(state.desktopLive);
  const settingsOpen = Boolean(state.settingsOpen);
  const crashed = Boolean(state.crashed);
  const showingDesktop = desktopLive || crashed;
  return {
    recover: true,
    nudge: true,
    reloadDesktop: showingDesktop && !settingsOpen,
    deferDesktopReload: showingDesktop && settingsOpen,
    reloadShell: !showingDesktop && Boolean(state.shellLoaded),
  };
};

module.exports = {
  MIN_OVERLAP,
  MIN_WINDOW,
  windowOnScreen,
  replacementBounds,
  nudgeSize,
  planDisplayWake,
};
