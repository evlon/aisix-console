#!/usr/bin/env bash
# Deploy the gateway + console as podman containers.
#
# Requirements: podman machine running (Windows), gateway image pulled, and the
# console image built (see Dockerfile):
#   podman pull ghcr.io/api7/aisix:0.8.1
#   podman build -t aisix-console:dev .
#
# This script copies the shared runtime files from templates if missing, then
# starts both containers on a private network. It is idempotent: re-running
# removes and recreates the containers.
set -euo pipefail

# Running from Git Bash on Windows: stop MSYS from rewriting Linux-style paths
# in args (e.g. the AISIX_CONSOLE_CONFIG env value /etc/... → C:/Program Files/Git/...).
export MSYS_NO_PATHCONV=1

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
# Podman on Windows needs a Windows-style path for volume mounts.
DEPLOY_DIR_WIN="$(cygpath -w "$DEPLOY_DIR" 2>/dev/null || echo "$DEPLOY_DIR")"
IMAGE_GW="ghcr.io/api7/aisix:0.8.1"
IMAGE_CONSOLE="${IMAGE_CONSOLE:-aisix-console:dev}"

for f in resources.yaml config.yaml aisix-console.yaml; do
  if [ ! -f "$DEPLOY_DIR/$f" ]; then
    case "$f" in
      resources.yaml)  cp "$DEPLOY_DIR/resources.template.yaml" "$DEPLOY_DIR/$f" ;;
      config.yaml)     cp "$DEPLOY_DIR/config.yaml" "$DEPLOY_DIR/$f" ;;  # committed template is the deploy config
      aisix-console.yaml) cp "$DEPLOY_DIR/aisix-console.container.yaml" "$DEPLOY_DIR/$f" ;;
    esac
  fi
done

# Host networking is used deliberately: custom netavark networks hit an
# nftables failure in the podman-machine VM ("netavark: nftables error"), and
# host networking lets the console reach the gateway at 127.0.0.1.
#
# The gateway needs the console keystore injected as env vars so ${VAR}
# references in resources.yaml resolve (the console injects them into
# `aisix validate`; the gateway needs them at load time too).
GW_ENV_ARGS=()
if [ -f "$DEPLOY_DIR/secrets.env" ]; then
  GW_ENV_ARGS=(--env-file "$DEPLOY_DIR_WIN/secrets.env")
  echo "== gateway env: injecting $DEPLOY_DIR/secrets.env =="
else
  echo "== gateway env: no secrets.env (${VAR} refs will fail) =="
fi

echo "== gateway container =="
podman rm -f aisix-gw >/dev/null 2>&1 || true
podman run -d --name aisix-gw --network=host "${GW_ENV_ARGS[@]}" \
  -v "$DEPLOY_DIR_WIN":/etc/aisix:rw \
  "$IMAGE_GW"

echo "== console container =="
podman rm -f aisix-console >/dev/null 2>&1 || true
podman run -d --name aisix-console --network=host \
  -v "$DEPLOY_DIR_WIN":/etc/aisix-console:rw \
  -e AISIX_CONSOLE_CONFIG=/etc/aisix-console/aisix-console.yaml \
  "$IMAGE_CONSOLE"

echo "== status =="
podman ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
