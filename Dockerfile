# syntax=docker/dockerfile:1
# aisix-console — personal web console for the AISIX AI Gateway (file mode).
#
# The console validates every save with `aisix validate`; the gateway binary
# is copied from the official gateway image so validation runs the exact
# binary the gateway runs in production.
#
# Build:   docker/podman build -t aisix-console .
# Run:     see deploy/podman-run.sh

# Pinned gateway image — bump alongside the gateway you deploy.
FROM ghcr.io/api7/aisix:0.8.1 AS gateway-image

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
# `aisix validate` binary, from the gateway image (not rebuilt here).
COPY --from=gateway-image /usr/local/bin/aisix /usr/local/bin/aisix
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev
COPY server/ ./server/
COPY --from=web-build /build/web/dist ./web/dist

ENV AISIX_CONSOLE_CONFIG=/etc/aisix-console/aisix-console.yaml
EXPOSE 8787
CMD ["node", "server/index.js"]
