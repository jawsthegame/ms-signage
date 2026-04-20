#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export DISPLAY=:0

# ── Display: rotate to portrait and set resolution ────────
UID_NUM=$(id -u)
if [ -S "/run/user/${UID_NUM}/wayland-0" ]; then
  export XDG_RUNTIME_DIR=/run/user/${UID_NUM}
  export WAYLAND_DISPLAY=wayland-0
  OUTPUT=$(wlr-randr 2>/dev/null | awk '/^[A-Z]/{print $1; exit}')
  if [ -n "$OUTPUT" ]; then
    wlr-randr --output "$OUTPUT" --mode 1920x1080 --transform 90 2>/dev/null \
      || wlr-randr --output "$OUTPUT" --transform 90 2>/dev/null
  fi
else
  OUTPUT=$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
  if [ -n "$OUTPUT" ]; then
    xrandr --output "$OUTPUT" --mode 1920x1080 --rotate right 2>/dev/null \
      || xrandr --output "$OUTPUT" --rotate right 2>/dev/null
  fi
fi

# Hide mouse cursor immediately (requires: sudo apt install unclutter)
unclutter -idle 0 -root &

# Launch Chromium in kiosk mode — relaunch automatically if it ever exits
# --password-store=basic suppresses the keyring password prompt
while true; do
  chromium \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-translate \
    --disable-session-crashed-bubble \
    --password-store=basic \
    http://localhost:3000/menu.html
  sleep 2
done
