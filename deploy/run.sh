#!/usr/bin/env bash
# Run the single aisix+console container. Seeds the data dir from templates
# on first run, then recreates the container (data volume persists).
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/evlon/aisix-console:latest}"
DATA_DIR="${DATA_DIR:-$HOME/aisix-data}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DATA_DIR"
[ -f "$DATA_DIR/config.yaml" ] || cp "$SCRIPT_DIR/config.yaml" "$DATA_DIR/config.yaml"
[ -f "$DATA_DIR/aisix-console.yaml" ] || cp "$SCRIPT_DIR/aisix-console.yaml" "$DATA_DIR/aisix-console.yaml"
[ -f "$DATA_DIR/resources.yaml" ] || cp "$SCRIPT_DIR/resources.template.yaml" "$DATA_DIR/resources.yaml"

docker rm -f aisix >/dev/null 2>&1 || true
docker run -d --name aisix \
  -p 3000:3000 -p 3002:3002 -p 9090:9090 -p 8787:8787 \
  -v "$DATA_DIR":/etc/aisix \
  "$IMAGE"

echo "AISIX running:  http://localhost:8787  (default password: aisix)"
echo "gateway:        :3000 (proxy) / :3002 (admin) / :9090 (metrics)"
echo "data dir:       $DATA_DIR"
