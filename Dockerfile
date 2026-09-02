# syntax=docker/dockerfile:1
# aisix-console — single image: AISIX AI Gateway + web console, one container.
#
# The gateway binary is built by CI from api7/aisix (a pinned commit for the
# stable track, main for the edge track) and passed in the build context as
# `aisix-bin/aisix` (see .github/workflows/build-image.yml). Locally,
# drop any Linux aisix binary there (e.g. extract it from the official image:
#   podman create ghcr.io/api7/aisix:0.8.1 --name gw-x
#   podman cp gw-x:/usr/local/bin/aisix aisix-bin/aisix
#   podman rm gw-x
# ).
#
# Both processes run under docker/entrypoint.sh, so the console hot-reloads the
# gateway with `kill -HUP $(cat /run/aisix.pid)` — same PID namespace.

# --- Build the Vue frontend ---------------------------------------------
FROM node:22-bookworm-slim AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY web/ ./web/
RUN npm run build -w web

# --- Runtime -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ARG AISIX_VERSION
LABEL org.opencontainers.image.base="node:22-bookworm-slim"
LABEL org.opencontainers.image.source="https://github.com/evlon/aisix-console"
LABEL org.opencontainers.image.description="AISIX AI Gateway + web console (single container)"
LABEL aisix.version="${AISIX_VERSION}"
# Gateway binary, built by CI (or provided locally in the build context).
COPY --chmod=755 aisix-bin/aisix /usr/local/bin/aisix
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
