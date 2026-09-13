# Movie Harbor 本机默认配置一致性设计

日期：2026-09-13

## 1. 背景与目标

当前仓库对同一组部署配置给出了互相矛盾的默认值：根 `.env.example` 使用示例 HTTPS 来源、Secure Cookie 和 5 GiB 单文件上限；生产 `docker-compose.yml` 与半离线包生成的 Compose 仍要求显式提供 `PUBLIC_ORIGIN`，并分别回退到 Secure Cookie 和 5 GiB。README 一方面把入口描述为本机 HTTP，另一方面又把环境变量示例描述为本机 HTTP 配置，实际示例却不是该配置。

本次修改把仓库提供的开箱默认场景统一为通过 `http://localhost:8080` 访问的本机部署，同时保留后端现有来源校验和正式 HTTPS 安全要求。目标是让根示例配置、生产 Compose、半离线 Compose、相关测试和 README 对默认值只有一种解释，避免复制示例后因来源缺失或 Cookie 策略冲突而无法启动，并把默认单文件上传上限统一提高到 50 GiB。

本文是对现有部署和半离线发布规格的增量修订。只要涉及下列三个默认值，以本文为准；其他运行拓扑、媒体存储、生命周期和发布包边界保持不变。

## 2. 精确默认值

三个配置项的仓库默认值固定为：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | 默认用户访问来源；必须带 `http://` 协议，不含路径、查询或片段 |
| `COOKIE_SECURE` | `false` | 仅适用于 localhost 或环回地址上的 HTTP 本机使用 |
| `MAX_UPLOAD_BYTES` | `53687091200` | 单个上传文件的最大字节数，等于 50 GiB，即 `50 × 1024³` 字节 |

`.env.example` 必须显式写出这三个值。生产 `docker-compose.yml` 和 `tools/offline-package.mjs` 生成的离线 Compose 必须分别使用完全相同的缺省回退：

```text
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-http://localhost:8080}
COOKIE_SECURE=${COOKIE_SECURE:-false}
MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES:-53687091200}
```

用户在 `.env` 或进程环境中显式提供的值继续覆盖 Compose 回退。`APP_PORT` 若改为非 `8080`，或者实际通过其他主机名、IP、端口或 HTTPS 入口访问，部署者必须同步把 `PUBLIC_ORIGIN` 改为浏览器实际使用的完整来源。

## 3. 涉及文件

实现只涉及以下文件：

- `.env.example`：写入新的三项显式默认值。
- `docker-compose.yml`：统一 API 服务的三项 Compose 缺省回退。
- `tools/offline-package.mjs`：统一 `renderCompose` 生成的离线 Compose 缺省回退；保留现有离线部署安全说明。
- `tests/offline-package.test.mjs`：更新并强化离线 Compose 的精确配置契约。
- `tests/compose-storage.test.mjs`：在现有真实 `docker compose config` 检查中增加根示例配置与生产 Compose 的默认值断言，存储挂载断言保持不变。
- `README.md`：修正默认本机访问、安全 Cookie 和默认上传容量说明。

后端 `backend/src/config.rs` 不修改。后端继续要求直接运行 API 时显式提供这些环境变量，并继续执行已有的来源、Cookie 和上传上限校验；本次只统一仓库部署入口向后端传入的默认值。

## 4. 运行时行为与安全边界

默认组合 `PUBLIC_ORIGIN=http://localhost:8080` 与 `COOKIE_SECURE=false` 应通过现有后端校验，可用于同一台机器上经 localhost 访问标准 Compose 暴露的 HTTP 入口。`PUBLIC_ORIGIN` 是来源而不是任意 URL，必须包含 `http://` 或 `https://` 协议与主机，可包含非默认端口，但不得包含凭据、路径、查询、片段、反斜杠或空白。

本机默认不扩大为公网或局域网明文 HTTP 支持：

- `COOKIE_SECURE=false` 仍只允许 `localhost`、IPv4 环回地址或 IPv6 环回地址；普通域名、局域网 IP、`0.0.0.0` 和公网地址仍由后端拒绝。
- 使用域名、局域网地址或公网地址时，正式部署必须配置实际的 `https://` 来源，并把 `COOKIE_SECURE` 设为 `true`。
- 项目内 Caddy 仍只提供 HTTP；正式 HTTPS 继续由部署者配置域名、外部反向代理或自己的 TLS 终止层。不得把新的本机默认解释为允许在公网以明文 HTTP 暴露管理后台。
- `PUBLIC_ORIGIN` 必须与浏览器实际访问的协议、主机名和非默认端口一致。例如使用 `http://127.0.0.1:8080` 访问时，应显式把默认的 `localhost` 改为 `127.0.0.1`。

`MAX_UPLOAD_BYTES` 只限制单个上传文件，不代表媒体库总容量，也不预留磁盘空间。50 GiB 在后端允许的正整数及数据库有符号 64 位范围内。后端现有 Tokio 流式写入、格式校验、临时文件、原子替换和失败恢复行为均不改变；部署者仍需为正式媒体、上传临时文件以及替换期间短暂并存的新旧文件预留足够空间。

密码、初始管理员凭据和 `TRUST_PROXY_SECRET` 不获得可用于生产的默认秘密，仍必须由部署者替换。数据目录、代理信任和媒体公开访问边界也不因本次修改而改变。

## 5. 半离线包一致性

半离线工具继续原样复制仓库 `.env.example` 到发布包，并通过 `renderCompose` 生成独立的 `compose.yml`。因此两条配置来源都必须包含相同的三项默认值；不能只更新根 Compose 或只更新被复制的示例文件。

离线 Compose 在未显式设置三项变量时应向 API 传入 `http://localhost:8080`、`false` 和 `53687091200`。包内 README 继续明确：默认 HTTP 仅用于本机或环回访问，目标服务器按服务器地址访问或用于正式服务时必须设置与实际入口匹配的 HTTPS 来源和 Secure Cookie。半离线模式、`linux/arm64` 平台限制、官方镜像联网获取、镜像白名单、校验和、宿主机数据目录及秘密排除规则保持不变。

## 6. 测试策略

### 6.1 Task 1 必须采用 TDD

配置与测试 Task 必须先修改 Node 测试，运行并确认测试因当前旧默认值而失败，再修改配置和模板使其通过。失败原因必须是以下预期差异，而不是环境、语法或无关测试故障：

- 根 `.env.example` 尚未给出 `http://localhost:8080`、`false` 和 `53687091200`。
- 生产 Compose 尚未使用相同的三项回退。
- 离线 `renderCompose` 尚未使用相同的三项回退。

测试至少覆盖：

1. 解析根 `.env.example`，精确断言三个显式值。
2. 使用真实 `docker compose config --format json` 解析生产 Compose，精确断言 API 最终获得三个默认值。
3. 对环境变量回退契约进行断言，防止 `.env.example` 的显式值掩盖生产 Compose 中仍然过时的回退表达式。
4. 解析 `renderCompose("test-v1")`，精确断言离线 API 环境中的三项回退字符串。
5. 保留并运行现有宿主机存储、离线镜像、归档白名单、HTTPS 指引与秘密排除测试，证明只改变目标默认值。

Task 1 的最小验证集为：

```bash
docker compose --env-file .env.example config --quiet
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
node --check tools/offline-package.mjs
git diff --check
```

若实现者新增独立的默认配置测试文件，应把它加入上述 Node 测试命令，并保持测试文件归属 Task 1。Task 2 只修改文档，不参与 Task 1 的红绿循环；完成后重新执行 `git diff --check` 并人工核对 README 中的数值与安全措辞。

## 7. Task 边界

实现必须拆成两个文件集合互不重叠、可独立审查的子 agent Task：

### Task 1：配置与测试

负责 `.env.example`、`docker-compose.yml`、`tools/offline-package.mjs`、`tests/offline-package.test.mjs`、`tests/compose-storage.test.mjs`，以及为默认配置契约确有必要新增的 Node 测试文件。该 Task 按第 6.1 节完成测试先红后绿，不修改 README 或其他产品文档。

### Task 2：README 文档

只负责 `README.md`。文档必须说明默认入口为 `http://localhost:8080`、默认 `COOKIE_SECURE=false` 仅限本机/环回 HTTP、正式 HTTPS 必须改为实际 `PUBLIC_ORIGIN` 并设 `COOKIE_SECURE=true`，以及默认单文件上限为 50 GiB（`53687091200` 字节）。该 Task 不修改配置、工具或测试。

两个 Task 均不得修改本设计规格。Task 1 与 Task 2 完成后由集成者统一检查工作树、运行相关验证并确认不存在交叉文件修改。

## 8. 非目标

- 不放宽后端对非环回来源使用不安全 Cookie 的拒绝规则。
- 不支持公网或局域网明文 HTTP 管理后台。
- 不为直接运行的后端进程增加隐式配置默认值。
- 不自动根据 `APP_PORT`、请求头、主机名或反向代理推导 `PUBLIC_ORIGIN`。
- 不自动配置域名、TLS 证书或 HTTPS 终止。
- 不改变允许的视频 MIME、流式上传、媒体存储、替换、删除或恢复协议。
- 不改变半离线包的平台、联网、镜像集合或归档结构。
- 不调整密码、管理员、代理秘密、数据库或宿主机目录默认策略。
- 不把 50 GiB 解释为磁盘配额、总媒体容量或推荐文件大小。

## 9. 验收标准

- `.env.example` 中三项值精确为 `http://localhost:8080`、`false` 和 `53687091200`。
- 生产 Compose 未设置三项变量时使用相同默认值，显式设置时仍尊重覆盖值。
- 半离线工具生成的 Compose 未设置三项变量时使用相同默认值，发布包复制的 `.env.example` 与之相符。
- 默认组合通过现有后端来源与 Cookie 校验；非环回来源配合 `COOKIE_SECURE=false` 仍被拒绝。
- README 把 50 GiB 明确描述为单文件上限，并保留磁盘容量规划提示。
- README 明确本机默认与正式 HTTPS 配置之间的边界，不出现允许公网明文 HTTP 的表述。
- Task 1 留有可复现的预期失败证据，并在实现后通过相关 Node、Compose 配置和语法检查。
- Task 1 与 Task 2 修改的文件集合互不重叠，没有无关生产代码、测试或文档改动。
- 最终 `git diff --check` 通过，规格与实现中不存在互相矛盾的三项默认值。
