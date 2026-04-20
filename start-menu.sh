#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export DISPLAY=:0

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
