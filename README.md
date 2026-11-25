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

**网关 + 控制台打成一个镜像** `ghcr.io/evlon/aisix-console`（CI 编译网关，双轨：稳定轨从 `api7/aisix` **最新 release**（构建时经 GitHub API 获取，验证门禁挡住 schema 漂移）编译、edge 轨从 `api7/aisix` main 编译；镜像带 `aisix.version` 标签，见 `.github/workflows/build-image.yml`）。**每日定时构建会重新拉取 aisix 最新 release 并刷新 `:latest`（同时打 `:aisix-X.Y.Z` 标签）** —— aisix 发版后约一天内 `docker pull` 即可拿到新网关；想要最新 main 特性用 `:edge`（在 Actions 页手动 `workflow_dispatch` 触发）。一个容器同时跑两个进程，保存配置后**自动热重载网关**。详见 **[deploy/README.zh-CN.md](deploy/README.zh-CN.md)**（英文版 [deploy/README.md](deploy/README.md)）。

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
| `metricsRetentionHours` | 用量数据保留时长（小时），到期自动清理并回收磁盘（默认 **24 小时**）。容量请按实测估：1,157 条序列 ≈ 167 万行/天 ≈ 1.0 GB/天，所以 24h≈1 GB、72h≈3 GB —— 想按周/月看用量请走 `observability_exporters` 送给 Prometheus，不要把本地样本留很长 |
| `reloadCommand` | 保存后重载命令；单容器部署用 `sh /usr/local/bin/gw-hup.sh`（扫本容器 `/proc` 找 `aisix` 进程发 SIGHUP，**无 pidfile**）；网关独立容器时改成 `docker kill -s HUP aisix`；留空则提示手动重载 |

环境变量覆盖：`CONSOLE_PORT`、`CONSOLE_BIND`、`CONSOLE_RESOURCES_FILE`、`CONSOLE_AISIX_BIN`、`CONSOLE_AUTH_FILE`、`CONSOLE_RELOAD_COMMAND`、`CONSOLE_PLAYGROUND_TIMEOUT_MS`、`CONSOLE_CONFIG`、`CONSOLE_DEFAULT_PASSWORD`、`CONSOLE_METRICS_DB`、`CONSOLE_METRICS_SCRAPE_INTERVAL_SECONDS`、`CONSOLE_METRICS_RETENTION_HOURS`（上述 `CONSOLE_*` 均有 `AISIX_CONSOLE_*` 别名可覆盖）。

### 用量统计看板（/metrics）

- **数据源**：网关默认开启的 Prometheus 监听（默认 `:9090` 的 `/metrics`）。控制台按 `metricsScrapeIntervalSeconds` 抓取，每个时间序列每分钟存一个点，按 `metricsRetentionHours` 滚动清理（默认 **24 小时**），所以网关重启后历史用量不丢。
- **长时间没采集成功后重启/升级，第一次成功采集会把窗口之外的历史样本一次性清掉**（文件随之回收，可能从几百 MB 缩到几 MB）。这是保留策略在正常工作，不是数据损坏 —— 但升级前请先备份 `metrics.db`。反过来也成立：**如果你发现库里堆着远超保留期的历史，说明采集早就在失败**（见下一条）。
- **前提**：`gateway.metrics` 必须能访问到运行中的网关；否则看板横幅会提示「网关不可达」，KPI 全 0。
- **采集停更会被说出来**：采集失败会写容器日志（`[metrics] 采集失败：<原因>`，首次即写、之后每分钟至多一条）；界面在最后一条样本超过 5 分钟时会显示「数据已停更 N 小时（最后一条 …）」。两者都没有、页面却显示零，才是「真的没有流量」。
- **指标**：请求量（按 outcome `success/client_error/upstream_error/rate_limited`）、输入/输出/总 Token、累计花费（micro-USD → USD）、请求延迟直方图（P50/P95）、在途请求数、限流拒绝数；并按 `model`、`api_key_id` 拆分明细。
- **依赖 Node 22+**：采集器使用内置 `node:sqlite`（Node 22.5+ 可用，仅打印 ExperimentalWarning，无需原生依赖）。
- **库变大后要复测聚合查询**：采集器本身已不再做全表统计，但用量页背后的聚合查询随库增长会变慢（3 GB 量级尚未实测）。复测时**必须同时看状态码与响应体大小** —— 只看 `time_total` 的探针会**把失败报告成变快**（登录态失效时返回 401 与几十字节，耗时反而小几十倍）：

  ```bash
  curl -s -o /dev/null \
    -w 'HTTP %{http_code}  %{time_total}s  %{size_download} 字节\n' \
    'http://127.0.0.1:8787/api/metrics/summary?range=24h'
  ```

  判据：正常是几十毫秒且体大小稳定在 KB 级；**若耗时爬进秒级并随库增长**，那是下一个问题（与采集器无关）。
- 数据仅本地落盘，不上报任何外部服务。

## resources.yaml 的文件格式（v1 / v2）

网关对 `resources.yaml` 的格式有一个**硬校验**，两个版本互不兼容（文件对不上就**整个加载失败**，不是某一条被拒）：

| | v1（「糖语法」） | v2（etcd 文档） |
|---|---|---|
| 版本字段 | `_format_version: "1"` | `_format_version: "2"` |
| 条目标识 | 无 `id`，靠 `display_name`/`name` 做身份 | **每条必须带小写带连字符的 UUID `id`** |
| 引用写法 | 名字，如 `provider_key: deepseek` | id，如 `provider_key_id: 07e1ef9f-…` |
| 适用网关 | aisix **≤ 1.10** | aisix **≥ 1.11** |

改动来自上游 `#1449`（`feat(file-source)!`，2026-11-18，v1.11.0）：它把 `_format_version` 变成硬等价判断，并**删除了整个 desugar 层**（`desugar.rs` / `derive_id`），也就是名字→id 的糖语法。所以 v1 文件在 1.11+ 上会让网关起不来，v2 文件在 1.10 及以前同样不行。

### 迁移

两种方式，任选其一：

- **控制台**：文件是 v1 时，页面顶部会出现横幅，点「迁移到 format 2」即可。
- **命令行**：`node server/scripts/migrate-resources-v2.mjs [--in-place] resources.yaml [out.yaml]`（幂等）。

**迁移是保 id 的**：每条资源的 `id` 用 `uuid5(命名空间, "<kind>/<身份>")` 派生 —— 与旧版网关自己算出来的**完全同一批 id**（控制台里 `deriveId` 已逐字节对齐）。所以升级不会让 `provider_key_id` / `api_key_id` 变新，指标、访问日志、预算记录继续指向同一个资源。

**迁移是自保护的**：它走正常保存管线，会先用配置的 `aisix validate` 校验。若当前网关二进制早于 1.11，它会以 `unrecognized _format_version "2"` 拒绝，**文件不会被改动**。所以误点不会把网关搞挂。

> 保存时控制台会保留文件已经声明的版本、并沿用既有 `id`（不会因为某次编辑就把资源换成新 id）。切换格式只能靠上面的显式迁移。

## 密钥接线

- **推荐（单容器）**：Provider Key 的 `api_key` **明文直写** resources.yaml，保存后自动热重载生效，无需任何环境变量注入，也无需重建容器
- **引用已有环境变量**（高级）：写 `${VAR}` 到 resources.yaml，需自行把变量注入网关进程环境（`docker run -e` / `--env-file` / systemd `EnvironmentFile`）
- ⚠️ 环境变量名不能以 `AISIX_` 开头：aisix 网关会把所有 `AISIX_*` 环境变量当作配置覆盖（`unknown field ...` 直接启动失败）。若用引用模式，请用 `CONSOLE_*` 等非 `AISIX_` 前缀
- 调用方密钥（caller key）仍只存 SHA-256 哈希，明文仅创建时显示一次

## 观测导出器（observability_exporters）

「资源集成 → 可观测性导出器」把网关的**逐请求遥测扇出到外部后端**（数据面直连，控制台不经手数据）：OTLP/HTTP（Grafana Cloud / Tempo / Jaeger / Langfuse / Honeycomb 等）、Datadog、阿里云 SLS、对象存储归档（S3 / GCS / Azure Blob）。长期、跨实例的统计交给外部仓库；控制台本地 SQLite 只负责即时、零依赖的视图。

**导出的形态是 traces 和 logs，不是 metrics** —— 网关没有 Prometheus remote-write，也没有 OTLP `/v1/metrics`。所以：

| 目标 | 能否直连 | 说明 |
|---|---|---|
| Datadog | ✅ | `kind: datadog`，原生日志入口 |
| 阿里云 SLS | ✅ | `kind: aliyun_sls`，PutLogs |
| Grafana（经 Tempo） | ✅ 间接 | `kind: otlp_http` → Tempo，token 在 span 属性里（`gen_ai.usage.input_tokens` / `output_tokens`） |
| Graphite 等纯指标库 | ❌ | 需要中间转换（OTel Collector / Grafana Alloy 从 traces 生成指标，或聚合日志） |

token 数就在导出的事件里，所以外部仓库可以直接做长期统计。

### `credential_ref` 不是密钥，是引用名

这是这一页最容易踩的坑：`credential_ref` 填的是**引用名**，网关投递时用它去**自己的进程环境变量**里取真正的密钥。页面会把引用名换算成需要设置的变量名，并显示当前是否已设置。

| kind | 引用名 `foo` → 网关需要的环境变量 |
|---|---|
| `aliyun_sls` | `SLS_CRED_FOO_AK_ID`、`SLS_CRED_FOO_AK_SECRET` |
| `datadog` | `DD_CRED_FOO_API_KEY` |
| `object_store`（s3） | `OBJSTORE_CRED_FOO_AWS_ACCESS_KEY_ID`、`OBJSTORE_CRED_FOO_AWS_SECRET_ACCESS_KEY`（可选 `OBJSTORE_CRED_FOO_AWS_SESSION_TOKEN`） |
| `object_store`（gcs） | `OBJSTORE_CRED_FOO_GCS_SERVICE_ACCOUNT_KEY` |
| `object_store`（azure_blob） | `OBJSTORE_CRED_FOO_AZURE_ACCOUNT`、`OBJSTORE_CRED_FOO_AZURE_ACCESS_KEY` |

`FOO` = 引用名转大写、**逐字符**把非字母数字替换成 `_`（不折叠连续下划线、不裁剪首尾；所以 `a__b` → `A__B`、`-x-` → `_X_`）。

三个必须知道的点：

- **别把密钥本身填进 `credential_ref`** —— 它会被当成引用名，永远解析不出来。这是最常见的误用。
- 这三个前缀**刻意不以 `AISIX_` 开头**：网关把所有 `AISIX_*` 当配置覆盖，`docker/entrypoint.sh` 启动网关前也会清掉它们。所以别改名。
- **默认部署下这些变量还没有注入路径**：`deploy/docker-compose.yml` 没有 `env_file`，`secrets.env` 只注入 `aisix validate` 子进程、不进网关进程。需要自己给 compose 的 `services.aisix` 加 `environment:`，或用 `docker run -e`/`--env-file`。界面里「查看注入方式」会给出可复制的片段。
- 页面上「是否已设置」读的是**控制台进程**的环境变量。单容器部署下控制台与网关共享容器环境，结论一致；分离部署时请以网关进程为准。

### 导出内容与隐私

`content_mode` 默认 `metadata_only`：只导出 token 数、模型、状态、耗时，**不含提示词与回复全文**。Token 统计不需要内容，保持默认。改成 `full` 才会把内容送去第三方（单字段按 `content_max_bytes` 截断，默认 128 KiB）。

> `otlp_http` 没有 `credential_ref`，鉴权走 `headers` —— 而 `headers` 是**明文**存在 resources.yaml 里的，注意别把它提交到公开仓库。

### 投递健康

导出器页顶部的「投递健康」回答「配完了吗、还在送吗」，数据来自 `aisix_usage_events_emitted_total` 与 `aisix_usage_event_drops_total`。

⚠️ **口径限制**：当前网关（0.8.x）只暴露**网关级**的发送/丢弃计数，**没有按导出器归因**的指标。新版 aisix 的 `aisix_otlp_fanout_drops_total{exporter,reason}` / `aisix_otlp_fanout_failures_total{exporter}` 会被自动探测，探测到才显示单个导出器的数字；探测不到就只给整体数字并说明原因，不会假装每个导出器都健康。

## 重载

保存配置后，`aisix validate` 通过即写文件并执行 `reloadCommand`：

- **单容器（推荐）**：`sh /usr/local/bin/gw-hup.sh` —— 已内置在 `deploy/aisix-console.yaml`，保存即自动生效。它**扫描本容器的 `/proc`** 找名为 `aisix` 的进程发 SIGHUP（没有 pidfile，所以不会出现 pidfile 过期）；网关跑在**独立容器**里时它找不到目标，需要换成下面的形式
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
  src/exporterCreds.js 观测导出器 credential_ref → 网关环境变量推导（只回名字，不回值）
  src/routes/          auth / resources / status / secrets / playground / metrics / exporters
web/             Vue 3 前端
  src/i18n/           中英语言包（zh-CN / en）
  src/stores/         status（网关轮询）+ auth（登录态）
  src/views/          Login · Settings · Dashboard · ProviderKeys · Models · ApiKeys · Policies · Playground · Secrets · RawYaml · Metrics · Resources
  src/components/     Chart（ECharts 封装）· ExporterForm（导出器向导）· ExporterHealth（投递健康）· Modal 等
  src/lib/            keygen + sha256（浏览器端生成/哈希调用方密钥）· exporterTargets（导出器目标目录与校验）
deploy/          单容器部署：Dockerfile、entrypoint、run.sh、compose、config/resources 模板、README
docker/          supervisor 入口（同时拉起网关 + 控制台）
```

## 测试

```bash
npm test            # 两个 workspace 都跑（node --test，无额外依赖）
npm test -w server  # credential_ref → 环境变量推导
npm test -w web     # 导出器目标目录 / 校验 / 线格式映射 / i18n 键完整性
```

导出器的 `credential_ref` 名字换算、各类 `kind` 的字段映射、以及网关 schema 正则的前端镜像都有单测 —— 这些是最容易和网关悄悄漂移的地方。i18n 测试会在漏翻译键时报错，避免界面上直接显示 `obs.xxx`。

### 渲染冒烟（发版前跑）

```bash
npm run start        # 另开一个终端，先把控制台跑起来
npm run smoke        # 逐条打开所有路由，断言「渲染出了内容」而不只是标题

# 打别人的部署实例（先用那个浏览器会话登录一次）
npm run smoke -- --base http://console.example:3000 --session deploy-check
```

**先在同一个会话里登录一次**：脚本不会替你登录，而且它**会检测这一点** —— 没登录时每条路由都渲染成登录页，看起来「全部正常」。缺侧边栏时它会直接报 `not logged in` 而不是给你一个空头通过。

**为什么它必须单独存在**：有一类缺陷构建不报、单测不报、控制台也看不到 —— 视图在**渲染期**抛错，Vue 把整页渲染成一个注释节点，于是「侧边栏 + 标题都在、正文空白」。这个仓库已经踩过四次：

- i18n 文案里有裸花括号（`{` / `}`）→ 消息编译失败
- 模板调用了 `<script setup>` 没定义的 `FL()` → 运行时报 `e.FL is not a function`
- `const` 辅助函数被写在它自己声明之前（TDZ）→ 整页空白，**曾随 v0.2.1 发布**
- 某种资源既没有表单分支、也没标「只有原始 YAML」→ 弹窗是空的

脚本的路由列表**从 `web/src/router.js` 读**，所以以后新增页面不会被漏掉；判据是「正文文本长度 > 标题长度 + 10」，也就是直接盯住那个失败签名，而不是某个拍出来的字数门槛。

它**故意不放进 `npm test`**：单元测试里不该有浏览器依赖，而一个「没有浏览器就静默跳过」的检查比没有检查更糟。

## 注意

- 本控制台以**文件模式**为前提：`resources_file` 指向 resources.yaml，网关不以 etcd 运行；Admin 写接口在文件模式下是 409，控制台不使用它，改走文件 + validate
- 保存时 `yaml` 包序列化会丢失文件中的注释（文档化取舍）
- 网关离线不影响配置管理（validate 不依赖运行中的网关）
- 默认只绑定 `127.0.0.1`；若暴露到局域网，建议在前面加 HTTPS（登录密码走明文 HTTP）
