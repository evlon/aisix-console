# Deploy — single container (gateway + console)

中文版：[README.zh-CN.md](README.zh-CN.md)

One image (`ghcr.io/evlon/aisix-console`) runs both the AISIX gateway and the
web console under a small supervisor (`docker/entrypoint.sh`). Because they
share one PID namespace, saving a config change in the console **hot-reloads
the gateway automatically** — no manual SIGHUP, no container recreate, even
for new provider keys (they are written as plaintext into `resources.yaml`).

## Build

The gateway binary is built by CI with a **two-track** strategy (see
`.github/workflows/build-image.yml`):

- **stable** — built from `api7/aisix` at a **pinned ref**
  (`AISIX_STABLE_REF`, currently `v1.11.0`) — deliberately **not**
  `releases/latest`. Published as `:latest` (and `:v*` on tag pushes).
- **edge** — built from `api7/aisix` `main` (newest features), published as
  `:edge`. Refreshed nightly and on `workflow_dispatch` (`track=edge`).

> ⚠️ **Why stable is pinned rather than tracking the newest release.** The
> console writes and validates `_format_version: "2"`, which only a gateway
> ≥ 1.11 can read — so "newest release" can bundle an `aisix` that rejects the
> console's own files. That is not hypothetical: while `v1.11.0`'s GitHub
> release was still a **draft**, `releases/latest` resolved to **1.10.0**.
> Pinning also makes a build reproducible. Bump `AISIX_STABLE_REF` when you want
> a newer gateway; the schema gate below still fails the build if the pinned
> gateway rejects the console's CI sample, and it *did* catch the reverse
> mismatch (gateway moved to 1.11 while the sample was still v1).
> Override per run with the `aisix_ref` input.

Every image carries an `aisix.version` OCI label recording the gateway build
(`docker inspect --format '{{.Config.Labels}}' <image>`).

**The image is multi-arch: `linux/amd64` and `linux/arm64`.** That matters for
信创 / Kunpeng-class (aarch64) hosts, where an amd64-only console simply cannot
run — no amount of emulation makes an Express + SSR console pleasant. The
gateway binary is taken **per target platform** from the official multi-arch
image (buildx builds each stage for the target platform), because a prebuilt
binary is not recompiled by a multi-platform build: an amd64 binary copied into
an arm64 image exec-fails, and the console's save path shells out to
`aisix validate`, so saving config breaks too. Override the source with
`--build-arg AISIX_GATEWAY_IMAGE=ghcr.io/api7/aisix:<tag>`.

CI still compiles `api7/aisix` on an amd64 runner — but only to resolve the
version and to run the schema-drift gate; that binary is no longer shipped.

**Local build** (no binary staging needed — the gateway comes from the upstream
image in the Dockerfile):

```bash
podman build -t aisix-console:dev .
# arm64 on an arm64 host, or a multi-arch manifest with buildx:
podman buildx build --platform linux/amd64,linux/arm64 -t aisix-console:dev .
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
- **The admin port here is 3002, not upstream's default 3001** — `deploy/config.yaml`
  sets it and `docker-compose.yml` maps it. Whatever you choose, the console's
  `gateway.admin` must point at the port the gateway actually binds, or the
  status page's `/admin/v1/health` readout goes blank.

## Hot reload & updates

- **Save any change in the console → gateway reloads automatically.** The
  console runs `sh /usr/local/bin/gw-hup.sh`, which **scans this container's
  `/proc`** for a process named `aisix` and sends it SIGHUP — there is **no
  pidfile** to go stale. Nothing else to run.
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

**The shipped scaffold is v2.** `deploy/resources.template.yaml` (seeded into a
fresh data dir by `run.sh`) declares `_format_version: "2"`, and so does the
console's own "create empty template". An empty v2 document is valid — the
per-row `id` rule only binds rows. On a gateway **older** than 1.11 you must
change that one line to `"1"`, or the gateway will not start at all.

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

3. **Four paths must be redirected to the mounted directory, or you get four
   different symptoms.** Their defaults are built from `PROJECT_ROOT` in
   `server/src/config.js:12-16`, so they land **inside the image** (`/app/...`),
   while the mounted directory is `/etc/aisix`. `deploy/aisix-console.yaml`
   already points them at the mount, so the single-container form is fine; a
   split deployment that keeps the defaults is not:

   | Setting | Default (in image) | Symptom if unset | Does the error point at the cause? |
   |---|---|---|---|
   | `resourcesFile` | `/app/resources.yaml` | the console edits the image's copy; the gateway never sees your change | no |
   | `secretsFile` | `/app/secrets.env` | **saving returns 409**, reporting "environment variable `X` is unset or empty" | **no — it points the wrong way** |
   | `authFile` | `/app/auth.json` | login password and session key reset to defaults on recreate | no |
   | `metricsDb` | image writable layer | all usage history lost on recreate | no |

   `secretsFile` is the hardest one to work out alone, because its error sends
   you to the **wrong place**. Saving runs `aisix validate` against a temp file,
   and that child's env is **the console process env ∪ the keys in `secretsFile`**
   (`env: { ...process.env, ...extraEnv }` in `server/src/validate.js:15`, called
   from `server/src/savePipeline.js:74`).

   So the single-container form works **not because `secretsFile` is set
   correctly but because `process.env` covers for it** — the gateway's variables
   live in the same container's environment. In a split deployment the console
   container does not have them, and `secretsFile` becomes the only channel. With
   the default pointing at `/app/secrets.env` while you wrote the secret to
   `/etc/aisix/secrets.env`, the validate child never sees it and reports
   "`VLLM_API_KEY` is unset" — **while that variable is perfectly fine in the
   gateway container.** Your first instinct will be to check the gateway, which
   is the wrong direction.

   The fix, in the console's `aisix-console.yaml`:

   ```yaml
   secretsFile: "/etc/aisix/secrets.env"
   ```

   Then put `VLLM_API_KEY=<value>` in the mounted directory (`chmod 600`), or add
   it from the console's own "Secrets" page — that page writes this very file. An
   equivalent option is to put the variables in the **console container's**
   `environment:` / `env_file:`, which the child inherits; but that copies the
   gateway's secrets into the console container, so `secretsFile` is better.

   **All four can also be overridden by environment variables (`CONSOLE_*`, see
   `server/src/config.js`), and the environment wins over the file** (defaults →
   file → environment). So when you recreate the container, **copy every
   `CONSOLE_*` from the old one**: a missed variable does not error, it silently
   falls back to the value in the file. The usual consequence is a missing
   `CONSOLE_METRICS_DB`, which moves the usage database elsewhere and **splits
   your metrics history** (the old one may hold hundreds of MB). To copy them:

   ```sh
   docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <old container>
   ```

## The console's own HTTP API, for scripts

The previous section says `resources.yaml` should have one writer. A script either
**takes over the whole file** or **goes through the console**. For the latter:

| Request | Effect |
|---|---|
| `GET /api/resources/<collection>` | list. The collection name is the top-level key in the file (`models`, `api_keys`, …) |
| `GET /api/resources/<collection>/<identity>` | read one |
| `PUT /api/resources/<collection>/<identity>` | update one, **a partial update by default** |
| `PUT` with `{"mode":"replace"}` in the body | replace the whole entry (what the "Raw YAML" tab does) |
| `POST /api/resources/<collection>` | create |
| `DELETE /api/resources/<collection>/<identity>` | delete |

**`<identity>` is the value of the identity field, not the `id`**, and which field
that is depends on the collection:

- `provider_keys`, `models`, `api_keys` → `display_name`
- `mcp_servers`, `a2a_agents`, `teams`, `users`, … → `name`; `pricing` → `key`
- a few are composite: `guardrail_attachments` is `guardrail-id/scope-type/scope`,
  `budgets` is `scope:target`; the singletons (`mcp_auth_settings`,
  `budget_policy`, `usage_accounting`) use the collection name itself

**Passing the `id` answers 404** — which reads like "no such entry" but is a wrong
identifier. And a rename changes the identity, so a script must re-`GET` after a
rename to learn the current name.

A save response carries three fields written for a human: `preserved` (the **paths**
of fields this submission did not mention and that were kept — paths only, never
values, because `provider_keys[].api_key` and `mcp_servers.secret` are plaintext in
this file), `renamed` (references updated by a rename), and a composed `notice`.

**To verify "a save loses no fields" yourself**: back the file up, make the change,
then change it back, and compare `sha256` and byte count. Byte-identical is the only
judgement that rules out dirty data all the way through (a stray empty `deny: []`,
for instance). A one-way change only supports the much weaker "the fields are still
there", which by construction cannot show you what was added. That is how the 910c
host verified the rename, and it is worth copying.

## Saving rewrites the whole file: comments are lost, and one writer only

A console save re-serialises the entire document (`serialize()` in
`server/src/resources.js`), so:

- **Comments you wrote in `resources.yaml` are not preserved**, and indentation
  and quoting style get normalised.
- **The semantics are preserved**: `_format_version`, each row's `id`, `${VAR}`
  placeholders and `key_hash` all survive unchanged.

Therefore, if a **generator script** and the console both write this file, they
overwrite each other: a console save drops the script's comments, and the next
script run wipes whatever you edited in the console.

**Convention: `resources.yaml` should have exactly one writer at a time.** If you
generate it with a script, let the console take over once the script has run; if
you need to regenerate, back up the console-side edits first.

## Editing one entry is a partial update, not a replacement

Saving a resource through a **structured form** submits only the fields that form
models, and the server merges them into the stored entry: fields the submission
does not mention keep their value. So renaming something no longer deletes the
fields the form happens not to model.

This behaviour was **fixed**, not designed in. It used to replace the row
wholesale (`arr[idx] = entry`), and the consequence was hard to notice: the API
key form has no `tpm`/`tpd`, so renaming a key in the UI silently removed its
token caps — HTTP 200, "saved" on screen. `tpm` is precisely the limit that stops
one caller from consuming the whole token quota.

The rules:

- An explicit `null` in the submission DELETES that field. It is the only way to
  clear a value — omitting a field means "leave it alone".
- When the payload really is the whole entry, send
  `"mode": "replace"` on `PUT /api/resources/<kind>/<identity>`. The console's
  "Raw YAML" tab takes that path, because editing raw YAML is how you remove a
  field by hand.
- Both modes report in the response:
  - `preserved`: the paths that were kept. **Paths only, never values** —
    `provider_keys[].api_key` and `mcp_servers.secret` are plaintext in this file,
    and a save response must not become a way to read them back.
  - `renamed`: the references updated when a model is renamed (each key's
    `allowed_models`, routing/ensemble/semantic members, and the `model:<name>`
    form in `cache_policies.applies_to`).
  - `notice`: that sentence, ready for a human; the UI shows it after "saved".

**Why a rename has to propagate**: models are referenced by name, so after a
rename the old name answers 404 (as if the model were gone) while the new name
answers 403 (as if the key lacked permission). Neither points at the cause, and
the caller's model list comes back empty.

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

The gateway does warn about the underlying confusion, in wording worth knowing
(`crates/aisix-core/src/config.rs`):

```
WARN aisix: <NAME> was not applied as a configuration override: it names no
  gateway setting, and a nested setting is spelled AISIX_<SECTION>__<KEY>.
  If the configuration reads it by name (etcd.password_env, a resources-file
  interpolation) it still applies; otherwise nothing reads it
```

That last clause is the answer: interpolation is a resources-file feature only.

**Upstream's own example invites this mistake.** `config.example.yaml` says:

```yaml
admin:
  addr: "127.0.0.1:3001"
  admin_keys:
    # Provide via env to avoid committing secrets.
    # - "${AISIX_ADMIN_KEY}"
    - "admin-local-only-change-me"
```

Uncommenting that line — the comment recommends exactly that — silently produces a
20-character literal as the admin key. The env form is right; the `${...}`
spelling is not, and only the resources file accepts it.

### A placeholder and a real value look identical

There is a second half to this failure that only shows up over time: a literal
`"${SOME_VAR}"` in a config file is **not distinguishable from a working value**,
so the mistake survives review and then behaves like a weak key. The same shape
bites when two copies of a config drift — a repo copy holding the placeholder and
a server copy holding the real value look equivalent in a diff, and re-uploading
the repo copy silently downgrades a real key to a guessable literal. Nothing
errors; authentication just starts accepting the wrong string.

Two habits that close it:

- Keep the file **byte-identical between repository and server**, and put the
  secret in the environment (or a `chmod 600` file the repository does not
  track). Then "which copy is deployed" stops mattering.
- Prefer a form that **fails loudly** when the value is absent. The gateway
  refuses to start with an empty `admin_keys` (it is a required field when
  `managed.enabled` is false), so moving the key out of the file turns a silent
  fallback into a startup error.

`deploy/config.yaml` ships a **known** `admin-local-test`: it is public, and the
admin listener is bound to `0.0.0.0:3002` and published on the host. Change it —
and change `adminKey` in `aisix-console.yaml` to match, or the console loses its
`/admin/v1/health` readout.

### The env override that does work, and its two traps

For a normal field the loader layers `AISIX_<SECTION>__<KEY>` on top of the
YAML. Scalar list fields are set with **commas**, not JSON — `admin.admin_keys`
is one of the registered list keys. Measured against
`ghcr.io/api7/aisix:1.11.0` with a config that has **no** `admin_keys` at all:

| env value | result |
|---|---|
| `probe-key-123` | gateway starts; `Bearer probe-key-123` → **200** |
| `["probe-key-456"]` | gateway starts, but the key is the **literal** `["probe-key-456"]` — the real key gets 401, and only the bracketed string authenticates |
| `__0=probe-key-789` (i.e. `AISIX_ADMIN__ADMIN_KEYS__0`) | gateway **fails to start**: `admin.admin_keys: invalid type: map, expected a sequence` |

`__` is the nesting separator, so the indexed form turns the list into a map and
the deserializer rejects it outright. Use `AISIX_ADMIN__ADMIN_KEYS=k1,k2`.

An env var is also more exposed than a file: anything that can inspect the
container or read `/proc/<pid>/environ` can read it, whereas a `chmod 600`
file is limited to root and the container user. Pick per your threat model.

### …but not in this image

`docker/entrypoint.sh` deliberately **unsets every `AISIX_*` variable** before
starting the gateway, so that a stray `AISIX_*` (or this image's own `CONSOLE_*`
neighbours) cannot be reinterpreted as a gateway config override:

```sh
unset $(env | sed -n 's/^\(AISIX_[A-Z0-9_]*\)=.*/\1/p')
```

Consequence: in the single-container image the gateway's configuration must come
from `config.yaml` — the `AISIX_*` channel is closed by design. In a split
deployment running the **official** image, `AISIX_*` works, and it has to be set
on the **gateway** container, not the console one.

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

Logs: the gateway and the console both write to stdout — use `docker logs aisix`
(lines prefixed `[entrypoint]` come from the supervisor). An earlier design
appended the gateway to `/var/log/aisix-gateway.log` inside the container's
writable layer with no rotation, which could fill it and leave the console unable
to start even after a restart; stdout lets the docker log driver rotate instead.
