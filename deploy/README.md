# Deploy the gateway + console inside WSL

The console manages a file-mode AISIX gateway. This directory holds the
deployment plumbing: the GitHub Actions workflow that builds the **Linux**
gateway binary (see `.github/workflows/build-aisix.yml`), and scripts to fetch
it into WSL.

## Why build the gateway on GitHub Actions?

WSL often has no C toolchain (`gcc`/`cmake`), and the gateway's Rust build
needs one (`ring`, `aws-lc`). GitHub's `ubuntu-latest` runners have the full
toolchain, so the workflow compiles `api7/aisix` for Linux x86_64 and publishes
the binary as an artifact (or a GitHub Release). You then download it and run
everything in WSL — where the gateway supports SIGHUP hot-reload.

## 1. Publish the console repo + build the binary

```bash
cd aisix-console
git push -u origin main            # create the GitHub repo first
# GitHub → Actions → "build aisix (linux) + release" → Run workflow
#   aisix_ref:        pinned to the commit this console was tested against
#   publish_release:  true → creates a GitHub Release (curl-downloadable)
```

Or push a `v*` tag to build the release-profile binary and publish a Release.

## 2. Fetch the Linux binary

```bash
# gh CLI (authed):
REPO=<you>/aisix-console TAG=build-main ./deploy/fetch-aisix-linux.sh
# behind a firewall (this machine), via the HTTP proxy:
PROXY=http://10.126.126.100:8888 REPO=<you>/aisix-console TAG=build-main \
  ./deploy/fetch-aisix-linux.sh
```

Copy it into WSL:

```bash
wsl
mkdir -p ~/bin && cp deploy/bin/aisix ~/bin/ && chmod +x ~/bin/aisix
~/bin/aisix --version
```

## 3. Run everything in WSL

```yaml
# ~/aisix-test/gateway.config.yaml
resources_file: "/home/<user>/aisix-test/resources.yaml"
proxy:
  addr: "0.0.0.0:3000"
admin:
  enabled: true
  addr: "127.0.0.1:3001"
  admin_keys: ["admin-local-test"]
observability:
  metrics:
    prometheus:
      enabled: true
      addr: "0.0.0.0:9090"
```

```yaml
# ~/aisix-test/aisix-console.yaml
port: 8787
bind: "127.0.0.1"
resourcesFile: "/home/<user>/aisix-test/resources.yaml"
aisixBin: "/home/<user>/bin/aisix"        # native Linux binary — no wrapper needed
secretsFile: "/home/<user>/aisix-test/secrets.env"
gateway:
  proxy: "http://127.0.0.1:3000"
  admin: "http://127.0.0.1:3001"
  metrics: "http://127.0.0.1:9090"
  adminKey: "admin-local-test"
reloadCommand: "kill -HUP $(pgrep -f 'aisix --config') || true"   # SIGHUP works in WSL
```

Start:

```bash
cd /mnt/d/repos/aisix-console
AISIX_CONSOLE_CONFIG=~/aisix-test/aisix-console.yaml node server/index.js &
~/bin/aisix --config ~/aisix-test/gateway.config.yaml &
```

Open http://localhost:8787 from Windows (WSL2 mirrored networking shares
localhost). The gateway now hot-reloads on SIGHUP after every console save.

## Old "Windows compile" path (deprecated)

`deploy/bin/` may also hold a Windows-built `aisix.exe` for reference. The
Windows-host + WSL-console split needed a `wslpath` wrapper for `validate`
(`deploy/aisix-wsl-validate.sh`) and had no hot reload — keep it only if you
specifically want the gateway on the Windows host.
