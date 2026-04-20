#!/bin/bash
# Adds display on/off schedule to crontab.
# 6:30 AM on, 8:30 PM off — edit times here if needed.

ON_TIME="30 6"
OFF_TIME="30 20"
UID_NUM=$(id -u)

# Auto-detect Wayland or X11
if [ -S "/run/user/${UID_NUM}/wayland-0" ]; then
  echo "Detected: Wayland"
  OUTPUT=$(XDG_RUNTIME_DIR=/run/user/${UID_NUM} WAYLAND_DISPLAY=wayland-0 wlr-randr 2>/dev/null | awk '/ "/{print $1; exit}')
  if [ -z "$OUTPUT" ]; then
    echo "Error: could not detect output via wlr-randr. Is it installed?"
    exit 1
  fi
  echo "Output: $OUTPUT"
  CMD_ON="XDG_RUNTIME_DIR=/run/user/${UID_NUM} WAYLAND_DISPLAY=wayland-0 wlr-randr --output ${OUTPUT} --on"
  CMD_OFF="XDG_RUNTIME_DIR=/run/user/${UID_NUM} WAYLAND_DISPLAY=wayland-0 wlr-randr --output ${OUTPUT} --off"
  GREP_PAT="wlr-randr"
else
  echo "Detected: X11"
  OUTPUT=$(DISPLAY=:0 xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
  if [ -z "$OUTPUT" ]; then
    echo "Error: could not detect output via xrandr."
    exit 1
  fi
  echo "Output: $OUTPUT"
  XAUTH="/home/$(whoami)/.Xauthority"
  CMD_ON="DISPLAY=:0 XAUTHORITY=${XAUTH} xrandr --output ${OUTPUT} --auto"
  CMD_OFF="DISPLAY=:0 XAUTHORITY=${XAUTH} xrandr --output ${OUTPUT} --off"
  GREP_PAT="xrandr --output"
fi

# Remove any existing display schedule entries, then add fresh ones
(crontab -l 2>/dev/null | grep -v 'wlr-randr' | grep -v 'xrandr --output'; \
  echo "${ON_TIME}  * * * ${CMD_ON}"; \
  echo "${OFF_TIME} * * * ${CMD_OFF}") | crontab -

echo "Crontab updated:"
crontab -l | grep "$GREP_PAT"
