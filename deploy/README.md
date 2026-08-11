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

**Fresh server (one-liner):**

```bash
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | sh
```

`install.sh` fetches the deploy scripts + config templates into
`~/aisix-console-deploy`, seeds the data dir (`~/aisix-data`), and starts the
container. It never overwrites existing data; env overrides:
`AISIX_INSTALL_BASE_URL` / `AISIX_IMAGE` / `AISIX_PROXY` / `AISIX_DATA_DIR` /
`AISIX_DEPLOY_DIR` / `AISIX_RUNNER` / `AISIX_PROXY_PORT` / `AISIX_ADMIN_PORT` /
`AISIX_METRICS_PORT` / `AISIX_CONSOLE_PORT` / `AISIX_NO_START=1`. Note: the
repo must be **public** for the raw.githubusercontent URL to work.

**China-friendly examples:**

```bash
# use a ghcr mirror + proxy + different ports to avoid conflicts
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | \
  AISIX_IMAGE=ghcr.nju.edu.cn/evlon/aisix-console:latest \
  AISIX_PROXY=http://127.0.0.1:7890 \
  AISIX_CONSOLE_PORT=8888 \
  sh
```

- `AISIX_PROXY` (or `HTTPS_PROXY`/`HTTP_PROXY`): used by curl for the script
  fetch and by **podman** for image pulls. The **docker daemon** does not use
  CLI proxy env — run.sh handles that three ways:
  1. **skopeo** (recommended): `apt/dnf/brew install skopeo`. skopeo transfers
     the image itself, honours the proxy env, and loads straight into
     docker/podman storage. run.sh uses it automatically for `docker` behind a
     proxy, or on any pull failure; force it with `AISIX_SKOPEO=1`.
  2. Configure the docker daemon proxy (run.sh prints the systemd drop-in).
  3. Point `AISIX_IMAGE` at a ghcr mirror (e.g. `ghcr.nju.edu.cn/...`).
- Port overrides only change the **host** mapping (`-p host:container`); the
  container's internal ports stay fixed, so the console keeps talking to the
  gateway on 127.0.0.1 regardless.

**From a clone (or after install.sh):**

```bash
bash deploy/run.sh                 # seeds ~/aisix-data, then docker/podman run
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
