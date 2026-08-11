# AISIX Console

个人使用的 AISIX AI Gateway（文件模式）Web 配置控制台。独立 git 项目，**不修改 aisix 源码**。

## 功能

- 管理 **Provider Keys / 模型 / 调用方 API Keys / 策略（限流·缓存·护栏）**，直接读写网关的 `resources.yaml`
- 每次保存都经过 **`aisix validate --resources`** 校验（与网关加载管线完全一致），出错时给出逐条中文错误、文件保持不变
- **状态看板**：`/status/config`（synced/rejected/partial-compat）+ `/status/models` 模型健康 + 资源数量
- **试玩页**：SSE 流式对话，真实转发到网关代理
- **密钥库**：Provider Key / key_env 明文只存 `secrets.env`，resources.yaml 里只写 `${VAR}`；调用方 key 在浏览器生成并 SHA-256，明文只显示一次
- 保存后执行可配置的 `reloadCommand`（如 `docker kill -s HUP aisix`），留空则提示手动重载

## 技术栈

Node.js（Express）后端 + Vue 3 / Vite 前端，npm workspaces 单仓库，生产模式后端托管构建产物。

## 安装与运行

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

## 配置（aisix-console.yaml）

| 字段 | 说明 |
|---|---|
| `resourcesFile` | 网关的 resources.yaml 路径 |
| `aisixBin` | aisix 二进制路径（保存时校验用） |
| `gateway.proxy/admin/metrics` | 网关三个监听地址 |
| `gateway.adminKey` | 可选，Admin API key（状态页 /health 用） |
| `reloadCommand` | 保存后重载命令；Windows 原生无 SIGHUP，留空手动重启 |

环境变量覆盖：`AISIX_CONSOLE_PORT`、`AISIX_CONSOLE_RESOURCES_FILE`、`AISIX_CONSOLE_AISIX_BIN`、`AISIX_CONSOLE_RELOAD_COMMAND`、`AISIX_CONSOLE_CONFIG`。

## 密钥接线（重要）

控制台把 Provider Key 明文存在 `secrets.env`，resources.yaml 只写 `${AISIX_CONSOLE_PK_xxx}`。
要让网关真正使用，需要把 `secrets.env` 注入网关进程环境：

- **Docker**：`docker run --env-file ./secrets.env ...`（或 `-e VAR=...`）
- **systemd**：`EnvironmentFile=/path/to/secrets.env`
- **手动**：`set -a; . secrets.env; set +a` 后再启动 aisix

## 重载

保存配置后，`aisix validate` 通过即写文件并执行 `reloadCommand`：

- Docker (Linux)：`docker kill -s HUP aisix`
- systemd：`systemctl reload aisix`
- Linux 原生：`kill -HUP <pid>`
- **Windows 原生：网关不支持 SIGHUP（`file_reload_loop` 仅 unix），改配置后必须重启网关** —— 此时 `reloadCommand` 留空，控制台会提示手动重启

## 目录结构

```
server/          Node.js 后端（Express）
  src/config.js        控制台配置加载
  src/resources.js     resources.yaml 文档模型（糖语法无损往返）
  src/secrets.js       secrets.env 密钥库
  src/validate.js      aisix validate 封装 + 错误解析
  src/savePipeline.js  保存管线：序列化→临时文件→校验→原子替换→reload
  src/routes/          resources / status / secrets / playground
web/             Vue 3 前端
  src/views/           Dashboard · ProviderKeys · Models · ApiKeys · Policies · Playground · Secrets · RawYaml
  src/lib/             keygen + sha256（浏览器端生成/哈希调用方 key）
```

## 注意

- 本控制台以**文件模式**为前提：`resources_file` 指向 resources.yaml，网关不以 etcd 运行；Admin 写接口在文件模式下是 409，控制台不使用它，改走文件 + validate
- 保存时 `yaml` 包序列化会丢失文件中的注释（文档化取舍）
- 网关离线不影响配置管理（validate 不依赖运行中的网关）
