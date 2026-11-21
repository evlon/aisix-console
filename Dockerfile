# syntax=docker/dockerfile:1
# aisix-console — single image: AISIX AI Gateway + web console, one container.
#
# The gateway binary comes from the OFFICIAL multi-arch image, not from a binary
# in the build context. That is what makes an arm64 build possible at all: the
# binary is a prebuilt artifact, so a multi-platform build does NOT recompile it
# — dropping an amd64 binary into an arm64 image yields a "green build, broken
# image" (the gateway refuses to exec, and the console's own save path shells out
# to `aisix validate`, so saving config breaks too). Building the stage from the
# upstream image lets buildx resolve the right architecture per platform.
#
# CI still compiles api7/aisix on an amd64 runner, but only to resolve the
# version and to run the schema-drift gate against `deploy/resources.ci-sample.yaml`;
# that binary is no longer shipped.
#
# Override AISIX_GATEWAY_IMAGE to build against a different upstream reference.
# For a fully offline/local build, extract the binary yourself instead:
#   podman create ghcr.io/api7/aisix:1.11.0 --name gw-x
#   podman cp gw-x:/usr/local/bin/aisix aisix-bin/aisix
#   podman rm gw-x
#
# Both processes run under docker/entrypoint.sh, so the console hot-reloads the
# gateway by SIGHUP via docker/gw-hup.sh — which finds the gateway by scanning
# this container's /proc for a process named `aisix` (no pidfile to go stale).

ARG AISIX_GATEWAY_IMAGE=ghcr.io/api7/aisix:1.11.0

# --- Gateway binary (per target platform) --------------------------------
# No `--platform=` flag: buildx already builds each stage for the TARGET
# platform, while an explicit flag would break a plain `docker build` (the
# variable is empty without BuildKit).
FROM ${AISIX_GATEWAY_IMAGE} AS gateway

# --- Build the Vue frontend ---------------------------------------------
FROM node:22-trixie-slim AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY web/ ./web/
RUN npm run build -w web

# --- Runtime -------------------------------------------------------------
# Debian 13 (trixie) — NOT bookworm. The gateway links against a newer glibc
# than bookworm ships: aisix 1.11.0 requires GLIBC_2.38/2.39 while bookworm has
# 2.36, so the gateway refuses to start ("version `GLIBC_2.39' not found"). The
# upstream image this binary comes from is itself Debian 13 (glibc 2.41), which
# is the floor this image has to meet.
FROM node:22-trixie-slim AS runtime
ARG AISIX_VERSION
LABEL org.opencontainers.image.base="node:22-trixie-slim"
LABEL org.opencontainers.image.source="https://github.com/evlon/aisix-console"
LABEL org.opencontainers.image.description="AISIX AI Gateway + web console (single container)"
LABEL aisix.version="${AISIX_VERSION}"
# Gateway binary, resolved for this image's architecture by the stage above.
COPY --from=gateway /usr/local/bin/aisix /usr/local/bin/aisix
# Supervisor entrypoint (gateway + console) and the reload helper.
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/aisix-console-entrypoint
COPY --chmod=755 docker/gw-hup.sh /usr/local/bin/gw-hup.sh

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev
COPY server/ ./server/
COPY --from=web-build /build/web/dist ./web/dist

# CONSOLE_* prefix (NOT AISIX_*): the aisix gateway in the same container
# treats every AISIX_* env var as a config override.
ENV CONSOLE_CONFIG=/etc/aisix/aisix-console.yaml
# Keep the usage store on the mounted data dir. Without this it defaults to
# /app/data/metrics.db inside the container's writable layer, so every recreate
# (every upgrade) silently discards the whole usage history.
ENV CONSOLE_METRICS_DB=/etc/aisix/metrics.db
EXPOSE 3000 3002 9090 8787

# Liveness probe for the console. The console is the part that can wedge (it
# does synchronous I/O on a bind-mounted volume and, before the restart-loop
# fix, would not recover from a crash). A wedged-but-alive console can't exit
# on its own, so this HEALTHCHECK + a restart policy (see deploy/run.sh
# --restart unless-stopped and compose restart:) is the backstop: if /api/health
# stops responding, docker/podman restarts the container. /api/health is
# intentionally public (unauthenticated) for exactly this reason.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/aisix-console-entrypoint"]
