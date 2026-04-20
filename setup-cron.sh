#!/bin/bash
# Adds display on/off schedule to crontab.
# 6:30 AM on, 8:30 PM off — edit times here if needed.

ON_TIME="30 6"
OFF_TIME="30 20"
UID_NUM=$(id -u)
OUTPUT="HDMI-A-1"

CMD_ON="XDG_RUNTIME_DIR=/run/user/${UID_NUM} WAYLAND_DISPLAY=wayland-0 wlr-randr --output ${OUTPUT} --on"
CMD_OFF="XDG_RUNTIME_DIR=/run/user/${UID_NUM} WAYLAND_DISPLAY=wayland-0 wlr-randr --output ${OUTPUT} --off"

# Remove any existing display schedule entries, then add fresh ones
(crontab -l 2>/dev/null | grep -v 'wlr-randr'; \
  echo "${ON_TIME}  * * * ${CMD_ON}"; \
  echo "${OFF_TIME} * * * ${CMD_OFF}") | crontab -

echo "Crontab updated:"
crontab -l | grep 'wlr-randr'
