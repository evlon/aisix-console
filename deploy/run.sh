#!/usr/bin/env bash
# Run the single aisix+console container. Seeds the data dir from templates
# on first run, then recreates the container (data volume persists).
#
# Overrides (env):
#   AISIX_IMAGE              container image (default: ghcr.io/evlon/aisix-console:latest)
#   AISIX_DATA_DIR           data dir mounted at /etc/aisix (default: ~/aisix-data)
#   AISIX_RUNNER             docker | podman (default: autodetect)
#   AISIX_PROXY              proxy for image pulls, e.g. http://127.0.0.1:7890
#                            (podman uses it; docker daemon does not — run.sh
#                            then uses skopeo automatically if installed)
#   AISIX_SKOPEO=1           force skopeo for the image fetch
#   AISIX_PROXY_PORT         host port for the proxy :3000 (default 3000)
#   AISIX_ADMIN_PORT         host port for admin :3002 (default 3002)
#   AISIX_METRICS_PORT       host port for metrics :9090 (default 9090)
#   AISIX_CONSOLE_PORT       host port for the console :8787 (default 8787)
set -euo pipefail

IMAGE="${AISIX_IMAGE:-ghcr.io/evlon/aisix-console:latest}"
DATA_DIR="${AISIX_DATA_DIR:-$HOME/aisix-data}"
PROXY="${AISIX_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Host ports (internal ports stay fixed; only the mapping is overridable).
P_PROXY="${AISIX_PROXY_PORT:-3000}"
P_ADMIN="${AISIX_ADMIN_PORT:-3002}"
P_METRICS="${AISIX_METRICS_PORT:-9090}"
P_CONSOLE="${AISIX_CONSOLE_PORT:-8787}"

# Container runtime: docker, or podman if docker is absent.
RUNNER="${AISIX_RUNNER:-}"
if [ -z "$RUNNER" ]; then
  if command -v docker >/dev/null 2>&1; then
    RUNNER=docker
  elif command -v podman >/dev/null 2>&1; then
    RUNNER=podman
  else
    echo "neither docker nor podman found" >&2
    exit 1
  fi
fi

# Proxy for the pull (podman honours these env vars; the docker daemon does not —
# see the note after run).
if [ -n "$PROXY" ]; then
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY"
  export NO_PROXY="localhost,127.0.0.1,${NO_PROXY:-}"
  echo "proxy: $PROXY"
fi

mkdir -p "$DATA_DIR"
[ -f "$DATA_DIR/config.yaml" ] || cp "$SCRIPT_DIR/config.yaml" "$DATA_DIR/config.yaml"
[ -f "$DATA_DIR/aisix-console.yaml" ] || cp "$SCRIPT_DIR/aisix-console.yaml" "$DATA_DIR/aisix-console.yaml"
[ -f "$DATA_DIR/resources.yaml" ] || cp "$SCRIPT_DIR/resources.template.yaml" "$DATA_DIR/resources.yaml"

# --- image acquisition ----------------------------------------------------
# Preferred: `$RUNNER pull` (podman honours the proxy env; docker daemon does
# not). Alternative: **skopeo** — it transfers the image itself, respects
# HTTP(S)_PROXY, and loads straight into the docker/podman storage. That makes
# it the cleanest proxy-friendly path for the docker daemon.
skopeo_copy() {
  local dest
  case "$RUNNER" in
    docker) dest="docker-daemon:$IMAGE" ;;
    podman) dest="containers-storage:$IMAGE" ;;
  esac
  echo "skopeo copy docker://$IMAGE -> $dest"
  skopeo copy "docker://$IMAGE" "$dest"
}

skopeo_hint() {
  echo "Install skopeo (apt/dnf/brew install skopeo), then rerun — run.sh will" >&2
  echo "use it to fetch the image through the proxy." >&2
}

fetch_image() {
  "$RUNNER" image exists "$IMAGE" 2>/dev/null && return 0
  # Force skopeo via AISIX_SKOPEO=1; also prefer it for docker+proxy (the
  # daemon ignores CLI proxy env, so a plain pull would fail behind a proxy).
  if [ "${AISIX_SKOPEO:-0}" = "1" ] || { [ -n "$PROXY" ] && [ "$RUNNER" = "docker" ]; }; then
    if command -v skopeo >/dev/null 2>&1; then
      skopeo_copy && return 0
      echo "skopeo copy failed" >&2
      skopeo_hint
      exit 1
    fi
    if [ "${AISIX_SKOPEO:-0}" = "1" ]; then
      echo "AISIX_SKOPEO=1 but skopeo is not installed" >&2
      skopeo_hint
      exit 1
    fi
  fi
  if "$RUNNER" pull "$IMAGE"; then return 0; fi
  # Fallback: pull failed — try skopeo if present.
  if command -v skopeo >/dev/null 2>&1; then
    echo "pull failed — falling back to skopeo" >&2
    skopeo_copy && return 0
    echo "skopeo copy failed" >&2
    skopeo_hint
    exit 1
  fi
  if [ -n "$PROXY" ] && [ "$RUNNER" = "docker" ]; then
    echo "docker pull failed. The docker daemon does NOT use the CLI proxy." >&2
    echo "Either install skopeo (the run.sh will use it automatically), or configure" >&2
    echo "the daemon proxy, e.g.:" >&2
    echo "  sudo mkdir -p /etc/systemd/system/docker.service.d && sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<EOF" >&2
    echo "  [Service]" >&2
    echo "  Environment=\"HTTP_PROXY=$PROXY\" \"HTTPS_PROXY=$PROXY\" \"NO_PROXY=localhost,127.0.0.1\"" >&2
    echo "  EOF" >&2
    echo "  sudo systemctl daemon-reload && sudo systemctl restart docker" >&2
    echo "or use AISIX_IMAGE to point at a ghcr mirror (e.g. ghcr.nju.edu.cn/evlon/aisix-console)." >&2
  else
    echo "failed to fetch image: $IMAGE" >&2
    echo "check network/registry, or install skopeo (apt/dnf/brew install skopeo)" >&2
    echo "and rerun — run.sh will fetch the image through the proxy." >&2
  fi
  exit 1
}

fetch_image

"$RUNNER" rm -f aisix >/dev/null 2>&1 || true
"$RUNNER" run -d --name aisix \
  -p "$P_PROXY:3000" -p "$P_ADMIN:3002" -p "$P_METRICS:9090" -p "$P_CONSOLE:8787" \
  -v "$DATA_DIR":/etc/aisix \
  "$IMAGE"

echo "AISIX running:  http://localhost:$P_CONSOLE  (default password: aisix)"
echo "gateway:        :$P_PROXY (proxy) / :$P_ADMIN (admin) / :$P_METRICS (metrics)"
echo "data dir:       $DATA_DIR"
