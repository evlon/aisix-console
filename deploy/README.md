# Deploy — single container (gateway + console)

One image (`ghcr.io/evlon/aisix-console`) runs both the AISIX gateway and the
web console under a small supervisor (`docker/entrypoint.sh`). Because they
share one PID namespace, saving a config change in the console **hot-reloads
the gateway automatically** — no manual SIGHUP, no container recreate, even
for new provider keys (they are written as plaintext into `resources.yaml`).

## Build

The gateway binary is built by CI with a **two-track** strategy (see
`.github/workflows/build-image.yml`):

- **stable** — built from `api7/aisix` at a pinned commit (the console's
  known-good gateway; it includes `claim_mappings`, which the latest
  `api7/aisix` release `v0.8.2` does **not** yet — so a release tag can't be
  used for stable until `api7/aisix` ships a release that includes it). The
  `evlon/aisix` fork is retired; this commit is an `api7/aisix` commit.
  Published as `:latest` (and `:v*` on tag pushes).
- **edge** — built from `api7/aisix` `main` (newest features), published as
  `:edge`. Refreshed nightly and on `workflow_dispatch` (`track=edge`).

Every image carries an `aisix.version` OCI label recording the gateway build
(`docker inspect --format '{{.Config.Labels}}' <image>`). For a local build,
drop any Linux `aisix` binary into `aisix-bin/aisix` first (e.g. extract it
from the official image):

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

## Base image and the gateway's glibc floor

The image runs both processes, so its base distribution must be able to execute
the gateway binary. That binary is compiled by CI on a modern runner and links
against a newer glibc than Debian 12 ships:

| | glibc |
|---|---|
| `node:22-bookworm-slim` (Debian 12) | 2.36 |
| **aisix 1.11.0** requires | up to **GLIBC_2.39** |
| `node:22-trixie-slim` (Debian 13) | 2.41 |
| upstream `ghcr.io/api7/aisix:1.11.0` image | 2.41 (Debian 13) |

With bookworm the gateway refuses to start:

```
aisix: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by aisix)
```

which leaves the console up and the gateway in the entrypoint's restart loop —
the container still reports `healthy`, because the healthcheck probes the
console. Hence the image is built `FROM node:22-trixie-slim` (Debian 13). If you
bump the gateway past a release that raises the glibc floor again, check
`ldd --version` in the target base before blaming the config.

## resources.yaml format

aisix ≥ 1.11 requires `_format_version: "2"` and a UUID `id` on every row; see
the main README's 「resources.yaml 的文件格式」 section. Migrate **before**
pointing a v1 file at a 1.11+ gateway — a mismatch fails the whole load, not one
row. The console shows a banner with a one-click migration, and
`node server/scripts/migrate-resources-v2.mjs` does the same thing offline.

## Running the console without the gateway (split deployment)

This image is a **two-process supervisor**: `docker/entrypoint.sh` starts the
gateway AND the console in one container, and the reload helper
(`docker/gw-hup.sh`) finds the gateway by scanning the container's own `/proc`
for a process named `aisix`. Two consequences when the gateway runs elsewhere
(e.g. the official `ghcr.io/api7/aisix` image in its own container):

1. **`reloadCommand` must be replaced.** The default `sh /usr/local/bin/gw-hup.sh`
   finds no gateway and exits 1; the console reports the save as done with a
   reload warning. SIGHUP is the only reload trigger — the admin listener has no
   reload route (every `/admin/v1/*` route is a GET and resource management is
   read-only), and the resources file has no watch — so a split deployment has to
   deliver the signal itself:

   ```yaml
   # console's aisix-console.yaml — pick one
   reloadCommand: "docker kill -s HUP aisix"      # needs the docker CLI in the image
   reloadCommand: "node /usr/local/bin/hup-remote.js"   # no CLI needed; node is already there
   ```

   Or give the console container the gateway's PID namespace
   (`--pid=container:aisix`) and leave the default alone. That couples their
   lifetimes.

2. **Do not run the console-only container from this image unmodified.** Its
   entrypoint will start a *second* gateway inside the console container (its own
   network namespace, so the ports bind fine). `gw-hup.sh` then finds a process
   named `aisix` — the wrong one — sends SIGHUP to it, exits 0, and the console
   reports a successful reload while the real gateway never reloads. That is a
   genuinely silent failure. Run the console alone instead:

   ```yaml
   services:
     console:
       image: ghcr.io/evlon/aisix-console:latest
       entrypoint: ["node", "/app/server/index.js"]   # skip the supervisor
       environment:
         - CONSOLE_CONFIG=/etc/aisix/aisix-console.yaml
       volumes:
         - /root/aisix-data:/etc/aisix
   ```

   (Contributions welcome: a `CONSOLE_ONLY=1` switch in the entrypoint, or a
   console-only image target, would make this a one-line change.)

## `config.yaml` does not interpolate `${VAR}`

Only the **resources file** goes through `${VAR}` interpolation — that lives in
the file channel (`aisix-etcd/src/file_source/yaml.rs`), not the config loader.
So this silently yields a 20-character literal as the admin key:

```yaml
# config.yaml — WRONG
admin:
  admin_keys:
    - "${AISIX_ADMIN_KEY}"
```

Put the real value in `config.yaml` (and restrict it: `chown` to the container
user, `chmod 600`), or override through the environment-variable mechanism the
config loader does support for individual fields. A resources-file reference is
the only place `${VAR}` means "read from the environment".

The console's own settings do not have this trap: `adminKey` in
`aisix-console.yaml` is read as a literal, and every `${VAR}` the docs mention
refers to `resources.yaml`.

## Observability exporter credentials

This compose file does **not** declare an `env_file`, and the data dir's
`secrets.env` is only injected into the console's `aisix validate` subprocess —
it never reaches the gateway. So an observability exporter's `credential_ref`
has no wiring path out of the box: the variable must be added to the gateway
process explicitly.

The console's exporter page derives the exact variable names from the reference
you type and shows which ones are already present, plus a paste-ready snippet.
In short, for a reference named `foo`:

| kind | variables the gateway reads |
|---|---|
| `aliyun_sls` | `SLS_CRED_FOO_AK_ID`, `SLS_CRED_FOO_AK_SECRET` |
| `datadog` | `DD_CRED_FOO_API_KEY` |
| `object_store` (s3) | `OBJSTORE_CRED_FOO_AWS_ACCESS_KEY_ID`, `OBJSTORE_CRED_FOO_AWS_SECRET_ACCESS_KEY` (+ optional `..._AWS_SESSION_TOKEN`) |
| `object_store` (gcs) | `OBJSTORE_CRED_FOO_GCS_SERVICE_ACCOUNT_KEY` |
| `object_store` (azure_blob) | `OBJSTORE_CRED_FOO_AZURE_ACCOUNT`, `OBJSTORE_CRED_FOO_AZURE_ACCESS_KEY` |

`FOO` is the reference upper-cased with each non-alphanumeric character folded
to `_`. Do **not** rename these prefixes to `AISIX_*`: the gateway treats that
namespace as config overrides and `docker/entrypoint.sh` strips it.

Add them to `services.aisix` in `docker-compose.yml`:

```yaml
services:
  aisix:
    environment:
      - SLS_CRED_FOO_AK_ID=…
      - SLS_CRED_FOO_AK_SECRET=…
```

then recreate the container (`docker compose up -d`) — an env change needs a
recreate, not a hot reload.

## Building the image in CI

`.github/workflows/build-image.yml` builds `aisix` (two-track; see above) and
pushes to `ghcr.io/evlon/aisix-console`. The `aisix_ref` input overrides the
track's default ref; the `track` input selects stable (`api7/aisix` pinned
commit → `:latest` / `:v*`) or edge (`api7/aisix` main → `:edge`):
- push to `main` → `latest` (stable)
- tag `v*` → `v*`
- nightly / `track=edge` → `edge`
- manual run with `aisix_ref` → `aisix-<version>`

Logs: the supervisor writes the gateway to `/var/log/aisix-gateway.log` inside
the container; `docker logs aisix` shows the console plus `[entrypoint]`
messages.
