#!/bin/sh
# Force every Chromium launch through the OneBridge proxy.
# Direct Chromium has no internet (network lock) and hangs forever on pages.
if [ -x /opt/bridge/launch-browser.sh ] && [ -f "${HOME:-/home/browser}/.bridge-credentials" ]; then
  exec /opt/bridge/launch-browser.sh "$@"
fi
if [ -x /usr/bin/chromium.real ]; then
  exec /usr/bin/chromium.real "$@"
fi
exec /usr/lib/chromium/chromium "$@"
