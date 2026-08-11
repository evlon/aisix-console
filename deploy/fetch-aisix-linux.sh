#!/usr/bin/env bash
# Download the aisix Linux binary built by the GitHub Actions workflow.
#
# Two modes:
#   1. gh CLI (authed): gh release download -R <owner>/<repo> <tag> -D <dir>
#   2. curl (public repo): works even behind a firewall via an HTTP proxy.
#
# Usage:
#   REPO=yourname/aisix-console TAG=build-main ./deploy/fetch-aisix-linux.sh
#   # or with an HTTP proxy for GitHub (as on this machine):
#   PROXY=http://10.126.126.100:8888 REPO=... TAG=... ./deploy/fetch-aisix-linux.sh
set -euo pipefail

REPO="${REPO:-}"
TAG="${TAG:-build-main}"
OUT_DIR="${OUT_DIR:-deploy/bin}"
PROXY="${PROXY:-}"
ASSET="aisix"

if [ -z "$REPO" ]; then
  echo "set REPO=<owner>/<repo> (and optionally PROXY=<http proxy> for curl mode)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

if [ -n "$(command -v gh)" ]; then
  echo "== downloading via gh release $TAG -R $REPO =="
  gh release download "$TAG" -R "$REPO" -D "$OUT_DIR" --pattern "$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
  echo "== downloading $URL =="
  if [ -n "$PROXY" ]; then
    curl --ssl-no-revoke -x "$PROXY" -fL -o "$OUT_DIR/$ASSET" "$URL"
  else
    curl -fL -o "$OUT_DIR/$ASSET" "$URL"
  fi
fi

chmod +x "$OUT_DIR/$ASSET"
echo "== binary at $OUT_DIR/$ASSET =="
file "$OUT_DIR/$ASSET" 2>/dev/null || true
"$OUT_DIR/$ASSET" --version 2>/dev/null || true
