#!/bin/sh
# AISIX Console + Gateway — one-line bootstrap installer.
#
#   curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | sh
#
# Fetches the deploy scripts and config templates into ~/aisix-console-deploy,
# seeds a data dir (~/aisix-data), and starts the single container. Idempotent:
# existing data (resources.yaml, auth.json, ...) is never overwritten.
#
# Overrides (env):
#   AISIX_INSTALL_BASE_URL   source of the deploy files (default: raw.githubusercontent)
#   AISIX_IMAGE              container image (default: ghcr.io/evlon/aisix-console:latest;
#                            in China use a ghcr mirror, e.g. ghcr.nju.edu.cn/evlon/aisix-console)
#   AISIX_PROXY              proxy for downloads, e.g. http://127.0.0.1:7890
#                            (also honours HTTPS_PROXY / HTTP_PROXY)
#   AISIX_DATA_DIR           data dir mounted at /etc/aisix (default: ~/aisix-data)
#   AISIX_DEPLOY_DIR         where the scripts go (default: ~/aisix-console-deploy)
#   AISIX_RUNNER             docker | podman (default: autodetect)
#   AISIX_PROXY_PORT         host port for the proxy :3000 (default 3000)
#   AISIX_ADMIN_PORT         host port for admin :3002 (default 3002)
#   AISIX_METRICS_PORT       host port for metrics :9090 (default 9090)
#   AISIX_CONSOLE_PORT       host port for the console :8787 (default 8787)
#   AISIX_NO_START=1         fetch + seed only, don't start the container
set -eu

BASE_URL="${AISIX_INSTALL_BASE_URL:-https://raw.githubusercontent.com/evlon/aisix-console/main/deploy}"
IMAGE="${AISIX_IMAGE:-ghcr.io/evlon/aisix-console:latest}"
DATA_DIR="${AISIX_DATA_DIR:-$HOME/aisix-data}"
TARGET_DIR="${AISIX_DEPLOY_DIR:-$HOME/aisix-console-deploy}"
PROXY="${AISIX_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}"

say() { echo "[aisix] $*"; }

command -v curl >/dev/null 2>&1 || { echo "[aisix] curl is required"; exit 1; }
if [ -n "${AISIX_RUNNER:-}" ]; then
  RUNNER="$AISIX_RUNNER"
elif command -v docker >/dev/null 2>&1; then
  RUNNER=docker
elif command -v podman >/dev/null 2>&1; then
  RUNNER=podman
else
  echo "[aisix] neither docker nor podman found" >&2
  exit 1
fi

# Proxy: curl (script fetch) honours these env vars; podman also uses them for
# image pulls. (docker daemon pulls need their own proxy config — see run.sh.)
if [ -n "$PROXY" ]; then
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY"
  export NO_PROXY="localhost,127.0.0.1,${NO_PROXY:-}"
  say "proxy: $PROXY"
fi

mkdir -p "$TARGET_DIR" "$DATA_DIR"

for f in run.sh config.yaml aisix-console.yaml resources.template.yaml docker-compose.yml; do
  say "fetching $f"
  curl -fsSL "$BASE_URL/$f" -o "$TARGET_DIR/$f"
done
chmod +x "$TARGET_DIR/run.sh"

# Seed the data dir — never overwrite existing config/data.
[ -f "$DATA_DIR/config.yaml" ] || cp "$TARGET_DIR/config.yaml" "$DATA_DIR/config.yaml"
[ -f "$DATA_DIR/aisix-console.yaml" ] || cp "$TARGET_DIR/aisix-console.yaml" "$DATA_DIR/aisix-console.yaml"
[ -f "$DATA_DIR/resources.yaml" ] || cp "$TARGET_DIR/resources.template.yaml" "$DATA_DIR/resources.yaml"

say "deploy scripts: $TARGET_DIR"
say "data dir:       $DATA_DIR"

if [ "${AISIX_NO_START:-0}" = "1" ]; then
  say "not starting (AISIX_NO_START=1). Start later with: bash $TARGET_DIR/run.sh"
  exit 0
fi

AISIX_RUNNER="$RUNNER" \
AISIX_IMAGE="$IMAGE" \
AISIX_DATA_DIR="$DATA_DIR" \
AISIX_PROXY="$PROXY" \
AISIX_PROXY_PORT="${AISIX_PROXY_PORT:-3000}" \
AISIX_ADMIN_PORT="${AISIX_ADMIN_PORT:-3002}" \
AISIX_METRICS_PORT="${AISIX_METRICS_PORT:-9090}" \
AISIX_CONSOLE_PORT="${AISIX_CONSOLE_PORT:-8787}" \
  bash "$TARGET_DIR/run.sh"
