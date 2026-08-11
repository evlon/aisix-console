# Deploy the gateway + console as containers (Podman / Docker)

The gateway runs the official image `ghcr.io/api7/aisix:0.8.1`; the console is
built from this repo's `Dockerfile` (it bakes in the gateway binary so every
console save is validated against the exact binary the gateway runs).

## Prerequisites

- Podman machine up (`podman machine start` — Windows; or Docker on Linux).
- Registry access to `ghcr.io` (public) and `docker.io`.

## Build + run

```bash
export PATH="$PATH:/c/Users/niukl/AppData/Local/Programs/Podman"   # Windows

podman pull ghcr.io/api7/aisix:0.8.1
podman build -t aisix-console:dev .          # from the repo root
bash deploy/podman-run.sh                    # creates + starts both containers
```

`deploy/podman-run.sh` is idempotent: it (re)creates `aisix-gw` and
`aisix-console` on a shared volume (`deploy/` mounted at `/etc/aisix` in the
gateway and `/etc/aisix-console` in the console), so both see the same
`resources.yaml`. On first run it copies:
- `resources.template.yaml` → `resources.yaml`
- `aisix-console.container.yaml` → `aisix-console.yaml`

## Login / security

The whole console (all pages + API) is behind a password login — unauthenticated
browsers only see the sign-in page.

- **Default password**: `aisix`, created on first boot in `deploy/auth.json`
  (persisted on the shared volume). Override the initial password with env
  `AISIX_CONSOLE_DEFAULT_PASSWORD` before the first boot.
- **Change it** in the console → Settings. After changing, you must sign in
  again with the new password.
- Sessions are signed cookies (HttpOnly, SameSite=Strict, 7-day); logging in
  survives container restarts. Login is rate-limited (5 failures → 15 min lock).
- `auth.json` holds only the scrypt password hash + a random session secret —
  never the plaintext password.
- The console still defaults to `bind: 127.0.0.1`. If you expose it beyond
  localhost, use HTTPS in front of it (e.g. a reverse proxy) — the password
  would otherwise travel in cleartext.

## How it fits together

```
Windows (localhost, mirrored WSL networking)
 ├─ podman machine (WSL) — aisix-gw :3000/:3002/:9090  (--network=host)
 └─ podman machine (WSL) — aisix-console :8787  (--network=host)
        │  writes deploy/resources.yaml (shared volume)
        ▼
   aisix-gw hot-reloads on SIGHUP
```

- The console UI: http://localhost:8787
- The gateway: proxy `:3000`, admin `:3002` (port 3001 is used by Tabby on this
  machine — adjust `deploy/config.yaml` + `deploy/aisix-console.container.yaml`
  if yours differs), metrics `:9090`
- **Networking is `--network=host`**: the podman machine shares localhost with
  Windows (mirrored WSL), so the console reaches the gateway at `127.0.0.1`.
  (A custom netavark network currently fails with an nftables error in the
  podman-machine VM — that's why host networking is used.)
- **Reload**: the console can't signal the gateway across containers. After a
  save, run `podman kill -s HUP aisix-gw`, or set `reloadCommand` in
  `deploy/aisix-console.yaml` to a command that can (e.g. a helper that calls
  the Podman REST API over a mounted socket).
- **New secrets need a container recreate**: `--env-file` is snapshotted at
  container creation. When you add a NEW provider key in the console (a new
  `${CONSOLE_PK_*}` var), SIGHUP alone won't work — the gateway can't resolve
  the new var and stays `out_of_sync`. Recreate the gateway:
  `bash deploy/podman-run.sh`. Only edits that don't introduce new secrets
  can be applied with SIGHUP.

## Notes / gotchas (this machine)

- **Git Bash rewrites `/etc/...` style args.** `deploy/podman-run.sh` sets
  `MSYS_NO_PATHCONV=1` internally; run it via `bash deploy/podman-run.sh`.
- **Mirrored WSL networking**: don't bind ports the Windows host already uses
  (3001 → Tabby, 8080 → an IDE helper, …). The gateway admin is on 3002 here.
- **Rootless socket**: if `podman` says "ssh: rejected: connect failed (open
  failed)", the machine's rootless socket isn't up. Fix (from the machine):
  `runuser -u user -- env XDG_RUNTIME_DIR=/run/user/1000 nohup podman system
  service --time=0 unix:///run/user/1000/podman/podman.sock &`
- **Image builds need `--network=host`** in the podman machine (npm registry
  connections get ECONNREFUSED on the default network):
  `podman build --network=host -t aisix-console:dev .`

## Optional: GitHub Actions release builds

`.github/workflows/build-aisix.yml` compiles the Linux gateway binary on GitHub
runners and publishes it as a release/artifact (useful if you can't pull the
image, or want a bare binary). Not needed for the container deployment.
