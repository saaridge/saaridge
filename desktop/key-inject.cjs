/**
 * Map Electron before-input-event → key-pump.sh lines (TYPE / KEY).
 * Kept free of Electron so keyboard regressions can unit-test the mapping.
 *
 * Cmd ≡ Ctrl inside the Linux guest. Printable chars use TYPE with the
 * character Electron already resolved (Shift+2 → "@") — never KEY shift+@.
 */
const XDOTOOL_SPECIAL = {
  Backspace: "BackSpace",
  Enter: "Return",
  Escape: "Escape",
  Tab: "Tab",
  Delete: "Delete",
  ArrowLeft: "Left",
  ArrowUp: "Up",
  ArrowRight: "Right",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Insert: "Insert",
  " ": "space",
};

/**
 * @param {{ type?: string, key?: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean }} input
 * @returns {string | null} full pump line including trailing newline, or null to skip
 */
function buildKeyPumpCommand(input) {
  if (!input || input.type !== "keyDown") return null;
  if (
    input.key === "Shift" ||
    input.key === "Control" ||
    input.key === "Alt" ||
    input.key === "Meta"
  ) {
    return null;
  }

  const wantCtrl = !!(input.control || input.meta);
  const wantAlt = !!input.alt;
  const wantShift = !!input.shift;
  const mods = [];
  if (wantCtrl) mods.push("ctrl");
  if (wantAlt) mods.push("alt");
  if (wantShift) mods.push("shift");

  const rawKey = String(input.key || "");

  // Printable / single-codepoint with no Ctrl/Alt: TYPE the produced character.
  // Electron already applied Shift+layout (Shift+2 → "@", Shift+1 → "!").
  // KEY shift+@ is invalid for xdotool and drops those characters.
  if (rawKey.length === 1 && !wantCtrl && !wantAlt) {
    return `TYPE ${rawKey}\n`;
  }

  const base =
    XDOTOOL_SPECIAL[rawKey] ||
    (rawKey.length === 1 ? rawKey.toLowerCase() : null);
  if (!base) return null;
  const combo = mods.length ? `${mods.join("+")}+${base}` : base;
  return `KEY ${combo}\n`;
}

module.exports = { buildKeyPumpCommand, XDOTOOL_SPECIAL };
