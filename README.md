# AISIX Console

个人使用的 AISIX AI Gateway（文件模式）Web 配置控制台。独立 git 项目，**不修改 aisix 源码**。Apache-2.0 开源。

## 功能

- **密码登录**：整个控制台（所有页面 + API）都需要登录，默认密码 `aisix`（可在「设置」改密），避免暴露
- **中英双语**：侧边栏一键切换「中文 / EN」，选择记住在本地
- 管理 **上游密钥 / 模型 / 调用方密钥 / 策略（限流·缓存·护栏）**，直接读写网关的 `resources.yaml`
- 每次保存都经过 **`aisix validate --resources`** 校验（与网关加载管线完全一致），出错时逐条提示、文件保持不变
- **状态看板**：`/status/config`（synced/rejected/partial-compat）+ `/status/models` 模型健康 + 资源数量
- **用量统计看板**（`/metrics`）：定时抓取网关 Prometheus `/metrics`，落盘 SQLite，展示请求量 / Token / 花费 / 延迟(P50·P95) 趋势，以及按模型、按调用方密钥的明细
- **试玩页**：SSE 流式对话，真实转发到网关代理
- **密钥库**：上游密钥 / key_env 明文只存 `secrets.env`，resources.yaml 只写 `${CONSOLE_PK_xxx}`；调用方密钥在浏览器生成并 SHA-256，明文只显示一次
- 保存后执行可配置的 `reloadCommand`（如 `podman kill -s HUP aisix-gw`），留空则提示手动重载

## 技术栈

Node.js（Express）后端 + Vue 3 / Vite 前端（vue-i18n 双语），npm workspaces 单仓库，生产模式后端托管构建产物。

## 部署（单容器，推荐）

**网关 + 控制台打成一个镜像** `ghcr.io/evlon/aisix-console`（CI 编译网关，双轨：稳定轨从 `api7/aisix` **最新 release**（构建时经 GitHub API 获取，验证门禁挡住 schema 漂移）编译、edge 轨从 `api7/aisix` main 编译；镜像带 `aisix.version` 标签，见 `.github/workflows/build-image.yml`）。**每日定时构建会重新拉取 aisix 最新 release 并刷新 `:latest`（同时打 `:aisix-X.Y.Z` 标签）** —— aisix 发版后约一天内 `docker pull` 即可拿到新网关；想要最新 main 特性用 `:edge`（在 Actions 页手动 `workflow_dispatch` 触发）。一个容器同时跑两个进程，保存配置后**自动热重载网关**。详见 **[deploy/README.md](deploy/README.md)**。

```bash
# 全新服务器一键安装：
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | sh

# 或已有代码：docker pull + bash deploy/run.sh
```

国内/改端口示例（env 覆盖）：

```bash
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | \
  AISIX_IMAGE=ghcr.nju.edu.cn/evlon/aisix-console:latest \   # ghcr 镜像加速
  AISIX_PROXY=http://127.0.0.1:7890 \                        # 代理（脚本下载 + podman 拉镜像）
  AISIX_CONSOLE_PORT=8888 AISIX_PROXY_PORT=4000 \            # 自定义宿主机端口，规避冲突
  sh
```

> docker daemon 不走 CLI 代理：如果 `docker pull` 拉取失败，**安装 skopeo**（`apt/dnf/brew install skopeo`）后重跑即可 —— run.sh 会自动用 skopeo 走代理拉镜像并灌入 docker 存储（`AISIX_SKOPEO=1` 可强制）。

- 端口：代理 `:3000`、admin `:3002`、metrics `:9090`、控制台 `:8787`（均可通过 `AISIX_*_PORT` 覆盖宿主机映射）
- 数据目录（挂载 `/etc/aisix`）：`config.yaml`、`resources.yaml`、`aisix-console.yaml`、`auth.json`、`secrets.env`，容器重建后保留
- **热重载**：控制台保存后自动 `sh /usr/local/bin/gw-hup.sh` 同容器生效
- **更新**：`docker pull` 新镜像 → 重建容器（`bash deploy/run.sh`），数据保留

## 本地 Node 开发/运行

要求：Node 20+；`aisix` 二进制（用于 validate，在 `../aisix/target/debug/aisix` 或自行配置）。

```bash
npm install
cp aisix-console.example.yaml aisix-console.yaml   # 修改 resourcesFile / aisixBin / 网关端口
```

开发模式（前端热更新，后端 :8787）：

```bash
npm run dev
# 打开 http://127.0.0.1:5173 （Vite 代理 /api → :8787）
```

生产模式（构建前端 + 后端托管）：

```bash
npm run build
npm start
# 打开 http://127.0.0.1:8787
```

## 登录认证

- 首次启动自动创建 `auth.json`（含密码哈希 + 随机会话密钥），默认密码 **`aisix`**；可用 env `CONSOLE_DEFAULT_PASSWORD` 覆盖首次密码
- 登录后在「设置」页修改密码；改密后需重新登录
- 会话为签名 Cookie（HttpOnly、SameSite=Strict、7 天），重启容器/服务后登录态保持
- 登录限流：5 次失败锁定 15 分钟
- `auth.json` 已 gitignore，只存 scrypt 哈希，绝不明文存密码

## 配置（aisix-console.yaml）

| 字段 | 说明 |
|---|---|
| `resourcesFile` | 网关的 resources.yaml 路径 |
| `aisixBin` | aisix 二进制路径（保存时校验用） |
| `secretsFile` | 密钥库 secrets.env 路径 |
| `authFile` | 登录认证文件 auth.json 路径（首次启动自动创建） |
| `gateway.proxy/admin/metrics` | 网关三个监听地址 |
| `gateway.adminKey` | 可选，Admin API key（状态页 /health 用） |
| `playgroundTimeoutMs` | 试玩请求超时（毫秒），防上游挂起卡死界面 |
| `metricsDb` | 用量数据点 SQLite 落盘路径（默认 `data/metrics.db`） |
| `metricsScrapeIntervalSeconds` | 抓取网关 `/metrics` 间隔（默认 10 秒） |
| `metricsRetentionDays` | 用量数据保留天数，到期自动清理（默认 7 天） |
| `reloadCommand` | 保存后重载命令；单容器部署用 `kill -HUP $(cat /run/aisix.pid)`；留空则提示手动重载 |

环境变量覆盖：`CONSOLE_PORT`、`CONSOLE_BIND`、`CONSOLE_RESOURCES_FILE`、`CONSOLE_AISIX_BIN`、`CONSOLE_AUTH_FILE`、`CONSOLE_RELOAD_COMMAND`、`CONSOLE_PLAYGROUND_TIMEOUT_MS`、`CONSOLE_CONFIG`、`CONSOLE_DEFAULT_PASSWORD`、`CONSOLE_METRICS_DB`、`CONSOLE_METRICS_SCRAPE_INTERVAL_SECONDS`、`CONSOLE_METRICS_RETENTION_DAYS`（上述 `CONSOLE_*` 均有 `AISIX_CONSOLE_*` 别名可覆盖）。

### 用量统计看板（/metrics）

- **数据源**：网关默认开启的 Prometheus 监听（默认 `:9090` 的 `/metrics`）。控制台按 `metricsScrapeIntervalSeconds` 抓取，每个时间序列每分钟存一个点，按 `metricsRetentionDays` 滚动清理，所以网关重启后历史用量不丢。
- **前提**：`gateway.metrics` 必须能访问到运行中的网关；否则看板横幅会提示「网关不可达」，KPI 全 0。
- **指标**：请求量（按 outcome `success/client_error/upstream_error/rate_limited`）、输入/输出/总 Token、累计花费（micro-USD → USD）、请求延迟直方图（P50/P95）、在途请求数、限流拒绝数；并按 `model`、`api_key_id` 拆分明细。
- **依赖 Node 22+**：采集器使用内置 `node:sqlite`（Node 22.5+ 可用，仅打印 ExperimentalWarning，无需原生依赖）。
- 数据仅本地落盘，不上报任何外部服务。

## 密钥接线

- **推荐（单容器）**：Provider Key 的 `api_key` **明文直写** resources.yaml，保存后自动热重载生效，无需任何环境变量注入，也无需重建容器
- **引用已有环境变量**（高级）：写 `${VAR}` 到 resources.yaml，需自行把变量注入网关进程环境（`docker run -e` / `--env-file` / systemd `EnvironmentFile`）
- ⚠️ 环境变量名不能以 `AISIX_` 开头：aisix 网关会把所有 `AISIX_*` 环境变量当作配置覆盖（`unknown field ...` 直接启动失败）。若用引用模式，请用 `CONSOLE_*` 等非 `AISIX_` 前缀
- 调用方密钥（caller key）仍只存 SHA-256 哈希，明文仅创建时显示一次

## 重载

保存配置后，`aisix validate` 通过即写文件并执行 `reloadCommand`：

- **单容器（推荐）**：`kill -HUP $(cat /run/aisix.pid)` —— 已内置在 `deploy/aisix-console.yaml`，保存即自动生效
- Docker（网关独立容器）：`docker kill -s HUP aisix`
- systemd：`systemctl reload aisix`
- Linux 原生：`kill -HUP <pid>`
- **Windows 原生：网关不支持 SIGHUP（`file_reload_loop` 仅 unix），改配置后必须重启网关** —— 此时 `reloadCommand` 留空，控制台会提示手动重启

## 目录结构

```
server/          Node.js 后端（Express）
  src/config.js        控制台配置加载
  src/auth.js          密码登录 + 签名 Cookie 会话 + 限流
  src/resources.js     resources.yaml 文档模型（糖语法无损往返）
  src/secrets.js       secrets.env 密钥库
  src/validate.js      aisix validate 封装 + 错误解析
  src/savePipeline.js  保存管线：序列化→临时文件→校验→原子替换→reload
  src/metrics.js       Prometheus 抓取 + 解析 + SQLite 落盘 + 聚合
  src/routes/          auth / resources / status / secrets / playground / metrics
web/             Vue 3 前端
  src/i18n/           中英语言包（zh-CN / en）
  src/stores/         status（网关轮询）+ auth（登录态）
  src/views/          Login · Settings · Dashboard · ProviderKeys · Models · ApiKeys · Policies · Playground · Secrets · RawYaml · Metrics
  src/components/     Chart（ECharts 封装）等
  src/lib/            keygen + sha256（浏览器端生成/哈希调用方密钥）
deploy/          单容器部署：Dockerfile、entrypoint、run.sh、compose、config/resources 模板、README
docker/          supervisor 入口（同时拉起网关 + 控制台）
```

## 注意

- 本控制台以**文件模式**为前提：`resources_file` 指向 resources.yaml，网关不以 etcd 运行；Admin 写接口在文件模式下是 409，控制台不使用它，改走文件 + validate
- 保存时 `yaml` 包序列化会丢失文件中的注释（文档化取舍）
- 网关离线不影响配置管理（validate 不依赖运行中的网关）
- 默认只绑定 `127.0.0.1`；若暴露到局域网，建议在前面加 HTTPS（登录密码走明文 HTTP）
