# 部署 —— 单容器（网关 + 控制台）

English: [README.md](README.md)

一个镜像（`ghcr.io/evlon/aisix-console`）在小 supervisor（`docker/entrypoint.sh`）
下同时跑 AISIX 网关和 Web 控制台。因为两者共享同一个 PID 命名空间，**在控制台里保存
配置就会自动热重载网关** —— 不需要手动 SIGHUP、不需要重建容器，新增上游密钥也一样
（它们以明文写进 `resources.yaml`）。

## 构建

网关二进制由 CI 构建，采用**双轨**策略（见 `.github/workflows/build-image.yml`）：

- **stable** —— 从 `api7/aisix` 的**钉定 ref** 构建（`AISIX_STABLE_REF`，当前 `v1.11.0`），
  **刻意不跟 `releases/latest`**。发布为 `:latest`（打 tag 时另有 `:v*`）。
- **edge** —— 从 `api7/aisix` 的 `main` 构建（最新特性），发布为 `:edge`。
  每晚刷新，也可在 Actions 页手动 `workflow_dispatch`（`track=edge`）。

> ⚠️ **为什么 stable 钉版本而不跟最新 release。** 控制台会写并校验
> `_format_version: "2"`，而**只有 ≥1.11 的网关能读** —— 所以「最新 release」可能给你
> 一个会拒绝控制台自己产出的文件的 `aisix`。这不是假设：在 `v1.11.0` 的 GitHub release
> 还是**草稿**期间，`releases/latest` 解析到的是 **1.10.0**。
> 钉定还能让构建可复现。想要更新的网关就改 `AISIX_STABLE_REF`；下面的 schema 门禁仍会在
> 「钉定的网关拒绝控制台的 CI 示例」时让构建失败 —— 而且它确实抓到过一次反向的不匹配
> （网关升到 1.11，而示例还是 v1）。
> 单次运行可用 `aisix_ref` 输入覆盖。

每个镜像都带一个 `aisix.version` OCI 标签，记录网关构建版本
（`docker inspect --format '{{.Config.Labels}}' <image>`）。

**镜像是多架构的：`linux/amd64` 与 `linux/arm64`。** 这对**信创 / 鲲鹏类（aarch64）**
机器是必需的 —— 只有 amd64 的控制台在那里根本跑不起来，靠模拟跑 Express + SSR 也不现实。
网关二进制是**按目标平台**从官方多架构镜像里取的（buildx 会为每个目标平台构建 stage）：
预先存在的二进制不会被多平台构建重编，把 amd64 二进制塞进 arm64 镜像会 exec 失败，
而且控制台保存配置时会调 `aisix validate`，**连保存都会坏**。可用
`--build-arg AISIX_GATEWAY_IMAGE=ghcr.io/api7/aisix:<tag>` 换来源。

CI 仍会在 amd64 runner 上编译 `api7/aisix`，但**只用于解析版本和跑 schema 漂移门禁**；
那份二进制不再进镜像。

**本地构建**（不再需要先把二进制放进 `aisix-bin/` —— Dockerfile 自己从上游镜像取）：

```bash
podman build -t aisix-console:dev .
# 在 arm64 机器上构建 arm64，或用 buildx 出多架构 manifest：
podman buildx build --platform linux/amd64,linux/arm64 -t aisix-console:dev .
```

> 基底镜像必须是 **Debian 13（trixie）**：网关二进制链接的 glibc 比 Debian 12 更新，
> 详见下文「基底镜像与网关的 glibc 下限」。

## 运行

**全新服务器（一行安装）：**

```bash
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | sh
```

`install.sh` 会把部署脚本与配置模板取到 `~/aisix-console-deploy`、初始化数据目录
（`~/aisix-data`）并启动容器。它**绝不覆盖已有数据**。可用环境变量覆盖：
`AISIX_INSTALL_BASE_URL` / `AISIX_IMAGE` / `AISIX_PROXY` / `AISIX_DATA_DIR` /
`AISIX_DEPLOY_DIR` / `AISIX_RUNNER` / `AISIX_PROXY_PORT` / `AISIX_ADMIN_PORT` /
`AISIX_METRICS_PORT` / `AISIX_CONSOLE_PORT` / `AISIX_NO_START=1`。
注意：仓库必须是 **public**，上面那个 raw.githubusercontent 地址才可用。

**国内网络示例：**

```bash
# 用 ghcr 镜像加速 + 代理 + 换端口避免冲突
curl -fsSL https://raw.githubusercontent.com/evlon/aisix-console/main/deploy/install.sh | \
  AISIX_IMAGE=ghcr.nju.edu.cn/evlon/aisix-console:latest \
  AISIX_PROXY=http://127.0.0.1:7890 \
  AISIX_CONSOLE_PORT=8888 \
  sh
```

- `AISIX_PROXY`（或 `HTTPS_PROXY`/`HTTP_PROXY`）：curl 拉脚本时用，**podman** 拉镜像时也用。
  **docker daemon 不走 CLI 的代理环境变量**，run.sh 用三种方式处理：
  1. **skopeo（推荐）**：`apt/dnf/brew install skopeo`。skopeo 自己传输镜像、遵循代理环境变量，
     并直接灌入 docker/podman 存储。run.sh 在「docker + 代理」或任何拉取失败时会自动使用它；
     可用 `AISIX_SKOPEO=1` 强制。
  2. 配置 docker daemon 代理（run.sh 会打印 systemd drop-in）。
  3. 把 `AISIX_IMAGE` 指向 ghcr 镜像源（如 `ghcr.nju.edu.cn/...`）。
- 端口覆盖只改**宿主机**映射（`-p host:container`）；容器内端口固定不变，所以控制台始终
  通过 127.0.0.1 访问网关。

**从 clone 开始（或 install.sh 之后）：**

```bash
bash deploy/run.sh                 # 初始化 ~/aisix-data，然后 docker/podman run
# 或
docker compose -f deploy/docker-compose.yml up -d
```

- 控制台：http://localhost:8787（默认密码 `aisix`，登录后在「设置」改）
- 网关：代理 `:3000`、admin `:3002`、metrics `:9090`
- 数据目录（挂载到 `/etc/aisix`）：`config.yaml`、`resources.yaml`、`aisix-console.yaml`、
  `auth.json`、`secrets.env` —— 容器重建后保留。
- **这里的 admin 端口是 3002，不是上游默认的 3001** —— 由 `deploy/config.yaml` 设定、
  `docker-compose.yml` 映射。无论你选哪个，控制台的 `gateway.admin` 都必须指向网关**实际**
  绑定的端口，否则状态页的 `/admin/v1/health` 读数会变空。

## 热重载与更新

- **在控制台保存任何改动 → 网关自动重载。** 控制台执行的是
  `sh /usr/local/bin/gw-hup.sh`：该脚本**扫描本容器的 `/proc`** 找到名为 `aisix` 的进程
  并发 SIGHUP（**没有 pidfile**，所以不会出现 pidfile 过期的问题）。无需其他操作。
- **新增上游密钥**会以明文写进 `resources.yaml` → 同样在下一次热重载生效，不需要环境变量
  接线、不需要重建容器。
- **更新**：`docker pull ghcr.io/evlon/aisix-console:latest` 后重建容器
  （再跑一次 `bash deploy/run.sh`，或 `docker compose up -d --pull always`）。数据卷保留。
- 高级的 `key_env` / `${VAR}` 引用仍要求该变量存在于**网关进程**的环境里
  （给 `docker run` 传 `-e` 或 `--env-file`）。

> 网关日志走 **stdout/stderr**，用 `docker logs aisix` 看。早期版本会往容器可写层里的
> `/var/log/aisix-gateway.log` 追加且不轮转，长期运行会把可写层撑满、连重启都救不回来，
> 所以已改为交给 docker 日志驱动处理轮转。

## 基底镜像与网关的 glibc 下限

镜像同时跑两个进程，所以它的基底发行版必须能执行网关二进制。该二进制由 CI 在较新的
runner 上编译，链接的 glibc 比 Debian 12 更新：

| | glibc |
|---|---|
| `node:22-bookworm-slim`（Debian 12） | 2.36 |
| **aisix 1.11.0** 要求 | 最高 **GLIBC_2.39** |
| `node:22-trixie-slim`（Debian 13） | 2.41 |
| 上游 `ghcr.io/api7/aisix:1.11.0` 镜像 | 2.41（Debian 13） |

用 bookworm 时网关拒绝启动：

```
aisix: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by aisix)
```

而**容器仍会报 `healthy`** —— 因为 healthcheck 探的是控制台 —— 于是表现为「控制台正常、
网关在 entrypoint 的重启循环里」。所以镜像改为 `FROM node:22-trixie-slim`（Debian 13）。
如果以后升级网关又撞到更高的 glibc 下限，先去目标基底里 `ldd --version` 确认，别先怀疑配置。

## resources.yaml 的文件格式

aisix ≥ 1.11 要求 `_format_version: "2"` 且**每行都带 UUID `id`**；见主 README 的
「resources.yaml 的文件格式」一节。把 v1 文件指向 1.11+ 网关**之前**必须先迁移 ——
格式对不上是**整个文件加载失败**，不是某一行被拒。控制台在文件是 v1 时会显示横幅并提供
一键迁移；`node server/scripts/migrate-resources-v2.mjs` 是等价的离线做法。

**出厂的脚手架就是 v2。** `deploy/resources.template.yaml`（`run.sh` 会给全新数据目录
播种它）声明 `_format_version: "2"`，控制台自己的「创建空模板」也一样。**空的 v2 文档是
合法的** —— 「每行必须带 id」只约束存在的行。若网关**早于 1.11**，必须把那一行改成 `"1"`，
否则网关**根本不会启动**。

## 拆分部署：只跑控制台（网关在别的容器里）

本镜像是**双进程 supervisor**：`docker/entrypoint.sh` 会在同一个容器里启动网关**和**控制台，
而重载助手（`docker/gw-hup.sh`）是靠**扫描本容器的 `/proc`** 找名为 `aisix` 的进程。
当网关跑在别处（例如官方的 `ghcr.io/api7/aisix` 镜像单独一个容器）时，有两个后果：

1. **必须替换 `reloadCommand`。** 默认的 `sh /usr/local/bin/gw-hup.sh` 找不到网关、以 1 退出；
   控制台会把保存标为已完成并给出重载警告。SIGHUP 是**唯一**的重载触发方式 —— admin 监听上
   没有任何重载路由（`/admin/v1/*` 全是 GET，资源管理是只读的），资源文件也没有文件监视 ——
   所以拆分部署必须自己把信号送过去：

   ```yaml
   # 控制台的 aisix-console.yaml —— 二选一
   reloadCommand: "docker kill -s HUP aisix"      # 需要镜像里有 docker CLI
   reloadCommand: "node /usr/local/bin/hup-remote.js"   # 不需要 CLI；镜像里本来就有 node
   ```

   或者给控制台容器共享网关的 PID 命名空间（`--pid=container:aisix`），默认配置就能用。
   代价是两个容器的生命周期被绑在一起。

2. **不要拿本镜像原样跑「只跑控制台」的容器。** 它的 entrypoint 会在控制台容器里再起
   **第二个网关**（自己的 network namespace，所以端口照样绑得上）。于是 `gw-hup.sh` 会找到
   一个名叫 `aisix` 的进程 —— **错的那个** —— 向它发 SIGHUP、以 0 退出，控制台报告重载成功，
   而真网关从不重载。**这是真正静默的失效。** 正确做法是只跑控制台：

   ```yaml
   services:
     console:
       image: ghcr.io/evlon/aisix-console:latest
       entrypoint: ["node", "/app/server/index.js"]   # 跳过 supervisor
       environment:
         - CONSOLE_CONFIG=/etc/aisix/aisix-console.yaml
       volumes:
         - /root/aisix-data:/etc/aisix
   ```

   （欢迎贡献：entrypoint 里加一个 `CONSOLE_ONLY=1` 开关，或一个 console-only 构建目标，
   就能变成一行的事。）

3. **四项路径必须重定向到挂载目录，否则有四类完全不同的症状。** 这几个默认值都由
   `server/src/config.js:12-16` 从 `PROJECT_ROOT` 拼出来，落在**镜像内部**（`/app/...`），
   而挂载目录是 `/etc/aisix`。单容器形态下 `deploy/aisix-console.yaml` 本来就把它们指过去了；
   拆分部署若沿用默认值就会踩到：

   | 配置项 | 默认（镜像内） | 不设的后果 | 报错是否指向真因 |
   |---|---|---|---|
   | `resourcesFile` | `/app/resources.yaml` | 控制台读写的是镜像里那份，网关永远看不到你的改动 | 否 |
   | `secretsFile` | `/app/secrets.env` | **保存配置 409**，报「environment variable `X` is unset or empty」 | **否 —— 方向完全错** |
   | `authFile` | `/app/auth.json` | 重建容器后登录密码与会话密钥重置回默认 | 否 |
   | `metricsDb` | 镜像可写层 | 重建容器丢掉全部用量历史 | 否 |

   `secretsFile` 这一条最难自己查出来，因为它的报错会把人送去**错的地方**：保存链路会跑
   `aisix validate` 校验临时文件，而那个子进程的 env 是**控制台进程 env ∪ `secretsFile` 里的键值**
   （`server/src/validate.js:15` 的 `env: { ...process.env, ...extraEnv }`，调用点在
   `server/src/savePipeline.js:74`）。

   于是：单容器形态能用，**不是因为 `secretsFile` 设对了，而是因为 `process.env` 兜住了** ——
   网关的变量就在同一个容器的环境里。拆分部署里控制台容器没有那些变量，`secretsFile` 就成了
   唯一通道。默认值指向 `/app/secrets.env`、而你把密钥写在 `/etc/aisix/secrets.env`，
   校验子进程就看不到它，于是报出「`VLLM_API_KEY` 未设置」—— **而它在网关容器里是好的**，
   第一反应会去查网关，方向完全错。

   修法（写进控制台的 `aisix-console.yaml`）：

   ```yaml
   secretsFile: "/etc/aisix/secrets.env"
   ```

   再在挂载目录放 `VLLM_API_KEY=<值>`（`chmod 600`），或者直接在控制台的「密钥」页里添加 ——
   它写的就是这个文件。等价做法是把变量放进**控制台容器**的 `environment:` / `env_file:`，
   子进程会继承它；但那等于把网关的密钥再抄一份到控制台容器，不如用 `secretsFile`。

## 保存会重写整个文件：注释会丢，且同一份文件只应有一个写入者

控制台保存时把整份文档重新序列化（`server/src/resources.js` 的 `serialize()`），因此：

- 你自己写在 `resources.yaml` 里的**注释不会被保留**，缩进与引号风格也会被重排。
- **语义原样保留**：`_format_version`、每行的 `id`、`${VAR}` 占位符、`key_hash` 都不会被改动。

所以如果同一份文件既有**生成脚本**在写、控制台也在写，两者会互相覆盖：控制台保存清掉脚本写的
注释；脚本一跑，又把你在控制台里做的编辑整个盖掉。

**约定：`resources.yaml` 同一时间只应有一个写入者。** 用脚本批量生成的话，脚本跑完就让控制台
接管；要重新用脚本生成，先把控制台里做过的改动备份出来。

## `config.yaml` 不插值 `${VAR}`

只有**资源文件**会走 `${VAR}` 插值 —— 实现在文件通道（`aisix-etcd/src/file_source/yaml.rs`），
**配置加载器不走**。所以下面这种写法会把管理密钥变成 20 个字符的**字面量**：

```yaml
# config.yaml —— 错的
admin:
  admin_keys:
    - "${AISIX_ADMIN_KEY}"
```

网关对底层的混淆是有告警的，原文值得记住（`crates/aisix-core/src/config.rs`）：

```
WARN aisix: <NAME> was not applied as a configuration override: it names no
  gateway setting, and a nested setting is spelled AISIX_<SECTION>__<KEY>.
  If the configuration reads it by name (etcd.password_env, a resources-file
  interpolation) it still applies; otherwise nothing reads it
```

最后半句就是答案：**插值是资源文件独有的能力**。

**上游自己的示例就在诱导这个错误。** `config.example.yaml` 里写的是：

```yaml
admin:
  addr: "127.0.0.1:3001"
  admin_keys:
    # Provide via env to avoid committing secrets.
    # - "${AISIX_ADMIN_KEY}"
    - "admin-local-only-change-me"
```

把那行取消注释 —— 而注释推荐的正是这个做法 —— 就会静默地得到一个 20 字符的**字面量**
管理密钥。「用环境变量」这个建议是对的，`${...}` 这个写法是错的，而且只有资源文件接受它。

### 占位符和真值长得一模一样

这类故障还有另一半，只在时间维度上显现：配置里的字面量 `"${SOME_VAR}"`
**和一个能用的值无法区分**，所以它在评审里看着没问题，之后就像一把弱密钥一样工作。
同一种形状也会在**两份配置漂移**时咬人 —— 仓库里那份拿着占位符、服务器上那份拿着真值，
在 diff 里看起来等价；**谁把仓库版重新上传，真值就静默降级成可猜的字面量**。不报任何错，
只是某个字符串开始被接受为凭据。

两个能关掉它的习惯：

- 让文件在**仓库与服务器之间逐字节一致**，把密钥放进环境变量（或一份仓库不跟踪的
  `chmod 600` 文件）。这样「部署的是哪一份」就不再要紧。
- 优先选**缺值就响亮失败**的形式。`admin_keys` 为空时网关**拒绝启动**
  （`managed.enabled` 为 false 时它是必填字段），所以把密钥移出文件，就把静默回退变成了
  启动报错。

`deploy/config.yaml` 出厂带的是一个**公开已知**的 `admin-local-test`：它写在仓库里，
而 admin 监听绑在 `0.0.0.0:3002` 且默认发布到宿主机。**请改掉它** —— 同时把
`aisix-console.yaml` 里的 `adminKey` 改成一致，否则控制台会失去 `/admin/v1/health` 读数。

### 真正可用的 env 覆盖，以及它的两个坑

普通字段由加载器用 `AISIX_<SECTION>__<KEY>` 叠在 YAML 之上。**标量序列字段用逗号，
不是 JSON** —— `admin.admin_keys` 就在已注册的列表键里。下表是在
`ghcr.io/api7/aisix:1.11.0` 上实测的，配置文件里**完全没有** `admin_keys`：

| env 值 | 结果 |
|---|---|
| `probe-key-123` | 网关启动；`Bearer probe-key-123` → **200** |
| `["probe-key-456"]` | 网关启动，但密钥是**字面量** `["probe-key-456"]` —— 真密钥 401，只有带方括号的那串能通过 |
| `__0=probe-key-789`（即 `AISIX_ADMIN__ADMIN_KEYS__0`） | 网关**启动失败**：`admin.admin_keys: invalid type: map, expected a sequence` |

`__` 是嵌套分隔符，所以带下标的形式把列表变成了 map，反序列化直接拒绝。
多值请写 `AISIX_ADMIN__ADMIN_KEYS=k1,k2`。

另外，env 比文件**更暴露**：任何能 inspect 容器或读 `/proc/<pid>/environ` 的人都能看到它，
而 `chmod 600` 的文件只有 root 和容器用户可读。按你的威胁模型选。

### ……但在本镜像里不行

`docker/entrypoint.sh` 在启动网关前**会主动 unset 所有 `AISIX_*` 变量**，以免杂散的
`AISIX_*`（或本镜像自己的 `CONSOLE_*` 邻居）被网关当成配置覆盖：

```sh
unset $(env | sed -n 's/^\(AISIX_[A-Z0-9_]*\)=.*/\1/p')
```

后果：**在单容器镜像里，网关配置只能来自 `config.yaml`**，`AISIX_*` 通道是设计上关死的。
而在跑**官方镜像**的拆分部署里 `AISIX_*` 是可用的，并且必须设在**网关**那个容器上，
不是控制台容器。

控制台自身的设置没有这个坑：`aisix-console.yaml` 里的 `adminKey` 就是按字面量读的，
文档里提到的所有 `${VAR}` 都指 `resources.yaml`。

## 观测导出器凭据

该 compose 文件**没有**声明 `env_file`，而数据目录里的 `secrets.env` 只被注入到控制台的
`aisix validate` 子进程 —— **它永远到不了网关**。所以观测导出器的 `credential_ref` 出厂时
没有任何接线路径：必须显式把变量加到**网关进程**上。

控制台的导出器页面会从你填的引用名推导出确切的变量名、显示哪些已经存在，并给出可直接
粘贴的片段。简言之，引用名为 `foo` 时：

| kind | 网关会读取的变量 |
|---|---|
| `aliyun_sls` | `SLS_CRED_FOO_AK_ID`、`SLS_CRED_FOO_AK_SECRET` |
| `datadog` | `DD_CRED_FOO_API_KEY` |
| `object_store`（s3） | `OBJSTORE_CRED_FOO_AWS_ACCESS_KEY_ID`、`OBJSTORE_CRED_FOO_AWS_SECRET_ACCESS_KEY`（可选 `..._AWS_SESSION_TOKEN`） |
| `object_store`（gcs） | `OBJSTORE_CRED_FOO_GCS_SERVICE_ACCOUNT_KEY` |
| `object_store`（azure_blob） | `OBJSTORE_CRED_FOO_AZURE_ACCOUNT`、`OBJSTORE_CRED_FOO_AZURE_ACCESS_KEY` |

`FOO` 是把引用名转大写、非字母数字字符逐字替换成 `_`。**不要**把这些前缀改成 `AISIX_*`：
网关把那个命名空间当配置覆盖，而 `docker/entrypoint.sh` 会清掉它。

把它们加进 `docker-compose.yml` 的 `services.aisix`：

```yaml
services:
  aisix:
    environment:
      - SLS_CRED_FOO_AK_ID=…
      - SLS_CRED_FOO_AK_SECRET=…
```

然后重建容器（`docker compose up -d`）—— 环境变量变更需要重建容器，**热重载不生效**。

## 在 CI 里构建镜像

`.github/workflows/build-image.yml` 构建 `aisix`（双轨，见上）并推送到
`ghcr.io/evlon/aisix-console`。`aisix_ref` 输入可覆盖该轨道的默认 ref；`track` 输入选择
stable（跟随 `api7/aisix` 最新 release → `:latest` / `:v*`）或 edge（`api7/aisix` main → `:edge`）：

- 推送到 `main` → `latest`（stable）
- 打 tag `v*` → `v*`
- 每晚 / `track=edge` → `edge`
- 手动跑并给 `aisix_ref` → `aisix-<version>`

日志：网关与控制台都写 stdout，用 `docker logs aisix` 看（其中 `[entrypoint]` 前缀的行来自
supervisor）。
