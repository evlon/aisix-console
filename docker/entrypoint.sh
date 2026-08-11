#!/bin/bash
# Single-container supervisor: run the AISIX gateway and the web console.
#
# - The gateway runs in the background; if it dies it is restarted (polled via
#   /proc, no pidfile dependency).
# - The console hot-reloads the gateway via `sh /usr/local/bin/gw-hup.sh`
#   (finds the aisix process in /proc and sends SIGHUP).
# - The console runs as a child; the container lifecycle follows it. On
#   SIGTERM/SIGINT both processes are stopped gracefully.
set -u

GATEWAY_CONFIG="${AISIX_GATEWAY_CONFIG:-/etc/aisix/config.yaml}"
mkdir -p /var/log /run

aisix_alive() {
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = "aisix" ] && return 0
  done
  return 1
}

start_gateway() {
  (
    # The gateway treats every AISIX_* env var as a config override and fails
    # on unknown fields — scrub them so the console's CONSOLE_* (and any
    # stray AISIX_*) vars never leak into the gateway process.
    unset $(env | sed -n 's/^\(AISIX_[A-Z0-9_]*\)=.*/\1/p')
    exec aisix --config "$GATEWAY_CONFIG" >> /var/log/aisix-gateway.log 2>&1
  ) &
}

start_gateway
echo "[entrypoint] gateway started" >&2

# Restart the gateway if it ever dies.
(
  while true; do
    sleep 5
    if ! aisix_alive; then
      echo "[entrypoint] gateway down, restarting" >&2
      start_gateway
    fi
  done
) &
WATCHER_PID=$!

node /app/server/index.js &
CONSOLE_PID=$!

shutdown() {
  kill -TERM "$CONSOLE_PID" 2>/dev/null || true
  for p in /proc/[0-9]*; do
    if [ "$(cat "$p/comm" 2>/dev/null)" = "aisix" ]; then
      kill -TERM "${p##*/}" 2>/dev/null || true
    fi
  done
  kill -TERM "$WATCHER_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait "$CONSOLE_PID"
shutdown
