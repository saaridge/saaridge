#!/bin/bash
# Launch OneBridge into the interactive macOS GUI session.
# (Background launches from Cursor/IDE often start Electron with no visible window.)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ELECTRON_BIN="$DIR/node_modules/.bin/electron"
ELECTRON_APP="$DIR/node_modules/electron/dist/Electron.app"

export ELECTRON_RUN_AS_NODE=
unset ELECTRON_RUN_AS_NODE

cd "$DIR"

if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "$ELECTRON_APP" ]]; then
  # `open` attaches to WindowServer so the window appears in the Dock / foreground.
  exec open -n -a "$ELECTRON_APP" --args "$DIR"
fi

exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON_BIN" .
