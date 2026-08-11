# Deploy — single container (gateway + console)

One image (`ghcr.io/evlon/aisix-console`) runs both the AISIX gateway and the
web console under a small supervisor (`docker/entrypoint.sh`). Because they
share one PID namespace, saving a config change in the console **hot-reloads
the gateway automatically** — no manual SIGHUP, no container recreate, even
for new provider keys (they are written as plaintext into `resources.yaml`).

## Build

The gateway binary is built by CI from `evlon/aisix` (see
`.github/workflows/build-image.yml`). For a local build, drop any Linux `aisix`
binary into `aisix-bin/aisix` first (e.g. extract it from the official image):

```bash
mkdir -p aisix-bin
podman create ghcr.io/api7/aisix:0.8.1 --name gw-x
podman cp gw-x:/usr/local/bin/aisix aisix-bin/aisix
podman rm gw-x

podman build --network=host -t aisix-console:dev .   # --network=host: npm registry
```

## Run

```bash
bash deploy/run.sh                 # seeds ~/aisix-data, then docker run
# or
docker compose -f deploy/docker-compose.yml up -d
```

- Console UI: http://localhost:8787 (default password `aisix`, change in Settings)
- Gateway: proxy `:3000`, admin `:3002`, metrics `:9090`
- Data dir (mounted at `/etc/aisix`): `config.yaml`, `resources.yaml`,
  `aisix-console.yaml`, `auth.json`, `secrets.env` — survives container
  recreates.

## Hot reload & updates

- **Save any change in the console → gateway reloads automatically**
  (`kill -HUP $(cat /run/aisix.pid)`, same container). Nothing else to run.
- **New provider keys** are written as plaintext into `resources.yaml` → they
  also apply on the next hot reload. No env wiring, no recreate.
- **Update**: `docker pull ghcr.io/evlon/aisix-console:latest` then recreate
  the container (`bash deploy/run.sh` again, or `docker compose up -d --pull
  always`). The data volume persists.
- Advanced `key_env` / `${VAR}` references still need the variable present in
  the gateway environment (pass `-e` or an `--env-file` to `docker run`).

## Building the image in CI

`.github/workflows/build-image.yml` builds `aisix` from the `evlon/aisix` fork
(`aisix_ref` input, pinned default), assembles the image, and pushes to
`ghcr.io/evlon/aisix-console`:
- push to `main` → `latest`
- tag `v*` → `v*`
- manual run → `aisix-<shortsha>`

Logs: the supervisor writes the gateway to `/var/log/aisix-gateway.log` inside
the container; `docker logs aisix` shows the console plus `[entrypoint]`
messages.
