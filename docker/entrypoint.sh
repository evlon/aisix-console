#!/bin/bash
# Single-container supervisor: run the AISIX gateway and the web console.
#
# - The gateway runs in the background; if it dies it is restarted (polled via
#   /proc, no pidfile dependency).
# - The console hot-reloads the gateway via `sh /usr/local/bin/gw-hup.sh`
#   (finds the aisix process in /proc and sends SIGHUP).
# - The console runs under a restart loop: if node exits (crash), it is
#   restarted in-place so a console crash doesn't take the whole container down.
#   A *wedged* (alive but unresponsive) console can't exit on its own, so the
#   Docker HEALTHCHECK + restart policy is the backstop for that case.
# - Container lifecycle follows a clean SIGTERM/SIGINT: both processes stop.
#
# Why logs go to stdout (not a file): the gateway used to append to
# /var/log/aisix-gateway.log in the container's writable layer with no rotation.
# Over long uptime that file grows without bound and can fill the writable
# layer — and `docker restart` does NOT clear the writable layer, so the
# console would fail to start even after a restart. Logging to stdout lets the
# docker log driver handle rotation instead.
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
    # Logs to stdout/stderr -> captured by `docker logs` (no unbounded file).
    exec aisix --config "$GATEWAY_CONFIG"
  ) &
}

# Remove stale temp files left in the data dir by saves interrupted by a
# previous SIGKILL/restart. They accumulate on the bind mount otherwise and
# (being in the volume) survive container recreates.
cleanup_tmp() {
  find /etc/aisix -maxdepth 1 \( -name '.*.tmp' -o -name '.*.validate' \) -delete 2>/dev/null || true
}
cleanup_tmp

STOP=0

shutdown() {
  STOP=1
  [ -n "${NODE_PID:-}" ] && kill -TERM "$NODE_PID" 2>/dev/null || true
  for p in /proc/[0-9]*; do
    if [ "$(cat "$p/comm" 2>/dev/null)" = "aisix" ]; then
      kill -TERM "${p##*/}" 2>/dev/null || true
    fi
  done
  [ -n "${WATCHER_PID:-}" ] && kill -TERM "$WATCHER_PID" 2>/dev/null || true
}
trap shutdown TERM INT

start_gateway
echo "[entrypoint] gateway started" >&2

# Restart the gateway if it ever dies (and we're not shutting down).
(
  while true; do
    sleep 5
    if [ "$STOP" = "0" ] && ! aisix_alive; then
      echo "[entrypoint] gateway down, restarting" >&2
      start_gateway
    fi
  done
) &
WATCHER_PID=$!

# Console: restart on exit so a crash doesn't take the whole container down.
# (A wedged-but-alive console is handled by the Docker HEALTHCHECK + restart
# policy, since a blocked event loop can't exit on its own.)
while [ "$STOP" = "0" ]; do
  node /app/server/index.js &
  NODE_PID=$!
  wait "$NODE_PID"
  [ "$STOP" = "1" ] && break
  echo "[entrypoint] console exited (rc=$?), restarting in 2s" >&2
  sleep 2
done

shutdown
exit 0
