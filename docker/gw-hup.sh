#!/bin/sh
# Send SIGHUP to the aisix gateway process in this container, so it reloads
# resources.yaml. Finds the process by scanning /proc (no pidfile to go stale).
found=0
for p in /proc/[0-9]*; do
  if [ "$(cat "$p/comm" 2>/dev/null)" = "aisix" ]; then
    kill -HUP "${p##*/}" 2>/dev/null
    found=1
  fi
done
if [ "$found" = "0" ]; then
  echo "aisix gateway not running" >&2
  exit 1
fi
