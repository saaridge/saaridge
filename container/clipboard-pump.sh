#!/usr/bin/env bash
# Clipboard pump: sync text between host Electron and X11 CLIPBOARD/PRIMARY.
# Protocol (stdin → stdout), one command per line:
#   SETB64 <base64-utf8>   → OK | ERR ...
#   GET                    → OKB64 c=<b64> p=<b64>
#     c = CLIPBOARD (Ctrl+C/V), p = PRIMARY (selection / middle-click)
#
# IMPORTANT: under `docker exec -i` stdout is a pipe (fully buffered). Re-exec
# with stdbuf -oL so Electron readline sees each reply immediately.
if [[ -z "${CLIPBOARD_PUMP_REEXEC:-}" ]] && command -v stdbuf >/dev/null 2>&1; then
  export CLIPBOARD_PUMP_REEXEC=1
  exec stdbuf -oL -eL "$0" "$@"
fi

set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

have_xclip=0
if command -v xclip >/dev/null 2>&1; then
  have_xclip=1
fi

reply() {
  printf '%s\n' "$1"
}

read_sel() {
  local sel="$1"
  if command -v timeout >/dev/null 2>&1; then
    timeout 0.5 xclip -selection "$sel" -o 2>/dev/null || true
  else
    xclip -selection "$sel" -o 2>/dev/null || true
  fi
}

b64_encode() {
  printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64
}

take_sel() {
  local sel="$1"
  local raw="$2"
  # xclip -i forks and holds the selection until replaced — required for Ctrl+V.
  printf '%s' "$raw" | xclip -selection "$sel" -i -quiet 2>/dev/null &
  sleep 0.05
}

set_clip() {
  local raw="$1"
  if [[ "$have_xclip" -ne 1 ]]; then
    reply "ERR xclip_missing"
    return
  fi
  take_sel clipboard "$raw" || {
    reply "ERR set_clipboard_failed"
    return
  }
  take_sel primary "$raw" || true
  local check
  check="$(read_sel clipboard)"
  if [[ "$check" != "$raw" ]]; then
    printf '%s' "$raw" | xclip -selection clipboard -i 2>/dev/null &
    sleep 0.08
    check="$(read_sel clipboard)"
    if [[ "$check" != "$raw" ]]; then
      reply "ERR set_clipboard_failed"
      return
    fi
  fi
  reply "OK"
}

get_clip() {
  if [[ "$have_xclip" -ne 1 ]]; then
    reply "ERR xclip_missing"
    return
  fi
  local c p
  c="$(read_sel clipboard)"
  p="$(read_sel primary)"
  reply "OKB64 c=$(b64_encode "$c") p=$(b64_encode "$p")"
}

while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ -z "${line:-}" ]] && continue
  cmd="${line%% *}"
  rest="${line#"$cmd"}"
  rest="${rest# }"
  case "$cmd" in
    SETB64)
      if [[ -z "$rest" ]]; then
        set_clip ""
        continue
      fi
      raw="$(printf '%s' "$rest" | base64 -d 2>/dev/null || printf '%s' "$rest" | base64 --decode 2>/dev/null || true)"
      set_clip "$raw"
      ;;
    GET)
      get_clip
      ;;
    *)
      reply "ERR unknown_cmd"
      ;;
  esac
done
