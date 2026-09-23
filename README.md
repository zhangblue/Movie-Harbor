# Movie Harbor

Movie Harbor 是一个面向个人或小型团队、可自行部署的电影与剧集媒体库。访客无需登录即可浏览、搜索和播放已发布内容；单一管理员通过独立后台维护电影、剧集、季、单集、题材、海报和视频。

快速入口：[生产部署](#生产部署) · [半离线发布包](#半离线发布包) · [备份与恢复](#一致备份与恢复) · [开发与验收](#开发与验收) · [项目文档](#项目文档)

## 当前状态

- 产品设计：已确认。
- UI Demo：已确认，保存在 `demo/`。
- 生产应用：已实现，可通过 Docker Compose 自托管。
- 内容列表：管理后台统一分页电影与剧集，公开站与管理后台均固定每页 20 条并支持数字页码。
- 媒体能力：支持同步删除与替换、启动恢复、H.264/HEVC MP4 和 WebM。
- 管理导出：详情展示视频容器内路径，支持一次下载全部内容的只读 JSON。
- 发布工具：支持生成 `linux/arm64` 和 `linux/amd64` 单平台半离线 Docker 部署包，默认使用 `linux/arm64`。

## 核心设计

- 内容支持电影和“剧集 → 季 → 集”两种结构。
- 电影、剧集和单集具有草稿、已发布、已归档状态，只有草稿可以编辑。
- 电影和剧集可不上传海报；缺失或加载失败时显示无文字的纯色占位。
- 单集不保存独立简介，详情页按季、集序号展示名称和时长。
- 访客无需账号；观看进度只保存在当前浏览器。
- 管理后台采用单一管理员账号。
- 视频不自动转码，管理员上传浏览器可直接播放的文件。
- 海报和视频保存在本地持久化媒体目录。
- 首版使用 Docker Compose 面向 NAS、个人服务器或小型 VPS 部署。

## 技术栈

- 公开站与管理后台：React + Vite + TypeScript，分别构建。
- 后端：Rust + Axum。
- 数据库访问：SeaORM + PostgreSQL。
- 异步运行时与文件操作：Tokio。
- 对外入口：同一域名下的 `/`、`/admin`、`/api` 和 `/media`。

## 项目文档

核心文档：

- [产品设计规格](docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md)
- [主实现计划](docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md)
- [协作约定](AGENTS.md)

当前关键增量：

- [媒体独占归属与发布体验](docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md)
- [宿主机数据目录映射](docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md)
- [半离线 Docker 发布包](docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md)
- [Linux AMD64 半离线发布包](docs/superpowers/specs/2026-09-23-linux-amd64-offline-package-design.md)
- [本机默认配置一致性](docs/superpowers/specs/2026-09-13-default-local-config-design.md)
- [HEVC MP4 上传与中文错误反馈](docs/superpowers/specs/2026-09-14-hevc-mp4-upload-and-localized-error-design.md)
- [管理与公开内容列表分页](docs/superpowers/specs/2026-09-15-admin-and-public-content-pagination-design.md)
- [前后端公共函数提取](docs/superpowers/specs/2026-09-15-common-function-extraction-design.md)
- [管理媒体路径显示与内容 JSON 导出](docs/superpowers/specs/2026-09-16-admin-media-path-and-json-export-design.md)

完整设计和实施记录位于 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。

## 管理媒体路径与内容导出

电影详情和剧集的单集视频区域显示已上传视频的只读“本地存储路径”，例如 `/media/video/ab/<uuid>.mp4`。这是容器内完整路径，不是 `MEDIA_HOST_DIR` 对应的宿主机绝对路径；未上传的视频不会显示路径，路径也不能用于修改媒体。

在管理后台“内容管理”标题旁点击“导出 JSON”，可下载 `movie-harbor-content-export-YYYYMMDD-HHmmss.json`，文件名时间使用服务端 UTC。导出包含全部草稿、已发布和已归档电影与剧集，不受当前筛选、搜索或分页影响；JSON 中不包含状态、数据库 ID 或媒体 ID。

电影和剧集都导出年份及题材名称数组：缺少年份显式为 `null`，无题材为 `[]`；单集不重复这些字段。电影还导出名称、简介、海报路径、视频路径和秒数；剧集还导出名称、简介、海报路径及扁平单集数组，每集包含季编号、集编号、名称、视频路径和秒数。海报路径和视频路径均为容器内路径；缺失的媒体或时长显式为 `null`。导出是只读元数据快照，不能导入，也不包含媒体文件，不能代替数据库与媒体目录的一致备份。

## 媒体目录安全边界

`MEDIA_DIR` 必须由后端进程的 OS 账号拥有，且不可对组用户或其他用户开放写权限。后端会在启动时验证该条件，并以 `0700` 创建私有 `.quarantine` 目录；权限不安全时会拒绝启动。部署时不得让其他服务共享该 OS 账号或获得媒体目录写权限。同一 OS 账号下运行的恶意进程能够修改应用自有文件，因此位于本地文件存储的信任边界内。

Compose 会先用一次性初始化容器把媒体卷根目录交给专用的 API 用户，并设为 `0700`。API 以 UID `10001` 读写媒体卷；入口 Caddy 仅以只读方式挂载同一卷。若改用宿主机目录绑定，请先执行 `chown 10001:10001 <目录>` 和 `chmod 0700 <目录>`，且不要把该目录写权限授予其他服务。

每个 `media_asset` 在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能被多个槽位共享。删除电影、剧集、季或单集时，API 会在同一请求内暂存对应文件、提交数据库删除并移除物理文件；替换海报或视频时也会在成功响应前同步移除旧媒体记录与旧文件。成功响应表示本次对应的数据库记录和物理文件均已处理，不需要另行等待垃圾回收。

系统不运行周期媒体垃圾回收任务。启动恢复只处理删除或替换请求在中断前已经写入持久清单的操作：数据库仍引用的文件会恢复到公开路径，已不再引用的隔离文件会完成删除；它不会扫描或自动删除任意孤立文件。因此数据库和媒体目录仍须作为一致的整体运维。

### 升级到数据库迁移 v5

迁移 v5 会把媒体所有权改为全局独占，并移除旧的 `file_cleanup_job` 周期清理队列。升级前必须先备份数据库和媒体目录，确认 `file_cleanup_job` 为空，并检查电影海报、电影视频、剧集海报和单集视频的全部引用；任何被多个槽位共享的媒体都必须先复制为各自独立的媒体记录和物理文件，再更新对应引用。迁移检测到待处理清理任务或共享引用时会拒绝升级，不会静默丢弃任务或猜测文件归属。

## 生产部署

要求安装 Docker Engine 与 Docker Compose v2。复制环境变量示例并替换密码与代理秘密；根据实际访问方式选择下方的本机、可信局域网或 HTTPS 配置：

```bash
cp .env.example .env
docker compose -p movie-harbor up -d --build --wait
```

默认本机入口是 `http://localhost:8080`。公开站位于 `/`，管理后台位于 `/admin/`，API 位于 `/api/`，媒体位于 `/media/`。PostgreSQL 不暴露宿主端口。修改 `APP_PORT` 时，即使仍从本机访问，也必须同步修改 `PUBLIC_ORIGIN` 的端口，例如改为 `http://localhost:9090`；可信局域网请求也只允许使用这个端口。

默认 `ALLOW_INSECURE_LAN_HTTP=false`，配合 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，只能从本机的 localhost 或环回地址完整操作管理后台。若改用 `http://127.0.0.1:8080`，必须将 `PUBLIC_ORIGIN` 改为这个实际来源；仅打开另一台电脑上的管理页面并不能完成登录和管理操作。

仅在受信任局域网内需要从其他设备管理时，可在 `.env` 中保持 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，将 `ALLOW_INSECURE_LAN_HTTP=true`，再重启 Compose 服务。从另一台电脑访问 `http://192.168.1.20:8080/admin/`，把 `192.168.1.20` 换成服务器的私有数字 IP。允许的 LAN 来源只接受私有 IPv4 或 IPv6 ULA 数字 IP，不接受局域网主机名；端口必须与 `PUBLIC_ORIGIN` 一致。localhost 与 IP 的 Cookie 分开保存，因此需要分别登录。此开关不会自动配置主机防火墙、路由器或网络可达性。

正式部署使用 HTTPS：把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 `https://` 来源（协议、主机名和非默认端口，不含路径），设置 `COOKIE_SECURE=true`、`ALLOW_INSECURE_LAN_HTTP=false`，并由部署者配置域名和 TLS 终止层。包内 Caddy 只提供 HTTP，不会自动取得证书。

局域网开关允许明文 HTTP，仅适用于受信任局域网；管理员密码和会话 Cookie 在网络传输途中可能被观察或篡改。访客 Wi-Fi、公共网络和公网端口映射不得启用该开关，也不能把它当作公网安全配置；这些环境应使用加密访问。

首次启动时，API 自动执行数据库迁移。只有数据库内尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号；之后修改 `.env` 或重启容器都不会覆盖已有管理员名称和密码。首次登录并修改密码后，应从 `.env` 移除初始凭据或换成无意义的占位值，但其余必填变量仍须保留。

关键环境变量：

| 变量 | 示例默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8080` | 宿主机入口端口；修改后同步调整 `PUBLIC_ORIGIN`。 |
| `DATABASE_HOST_DIR` | `./data/postgres` | PostgreSQL 宿主机持久目录。 |
| `MEDIA_HOST_DIR` | `./data/media` | 海报和视频宿主机持久目录。 |
| `POSTGRES_DB` / `POSTGRES_USER` | `movie_harbor` | Compose 使用的数据库名与账号。 |
| `POSTGRES_PASSWORD` | 无安全默认值 | 必须替换为随机数据库密码。 |
| `ADMIN_NAME` / `ADMIN_INITIAL_PASSWORD` | `admin` / 无安全默认值 | 仅在空库首次创建管理员时使用。 |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | 默认本机来源；修改 `APP_PORT` 时同步改端口，正式 HTTPS 部署改为实际 `https://` 来源。可信局域网模式保持本机来源。 |
| `COOKIE_SECURE` | `false` | 本机和显式开启的可信局域网 HTTP 使用 `false`；正式 HTTPS 部署设为 `true`。 |
| `ALLOW_INSECURE_LAN_HTTP` | `false` | 默认只允许本机完整操作后台；仅在受信任局域网中显式设为 `true`，允许同端口的私有数字 IP HTTP 管理访问。 |
| `TRUST_PROXY_SECRET` | 无安全默认值 | Caddy 与 API 之间的独立代理认证秘密，至少 32 字节。 |
| `MAX_UPLOAD_BYTES` | `53687091200` | 单文件上限，默认 50 GiB。 |
| `VIDEO_MIME_ALLOWLIST` | `video/mp4,video/webm` | 允许进入结构化格式校验的视频 MIME。 |

数据库连接必须二选一：直接运行 API 时可只设置 `DATABASE_URL`；Compose 使用 `DATABASE_HOST`、`DATABASE_PORT`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 这组分项变量。为避免迁移和运行时误连不同数据库，两种方式同时出现时 API 会拒绝启动。

登录限流默认只信任 API 连接的对端地址，并忽略客户端提供的 `X-Forwarded-For`。标准 Compose 不向宿主机暴露 API，由 Caddy 覆盖该请求头为实际客户端地址，并用独立的 `TRUST_PROXY_SECRET` 向 API 认证代理身份。请把示例值替换为至少 32 字节的随机秘密且不要复用其他密码。仅当 API 只能由持有该秘密且会覆盖（而非追加）该请求头的受信反向代理访问时才可开启 `TRUST_PROXY_HEADERS`；直接暴露 API 时必须保持关闭。

本机、可信局域网和正式 HTTPS 的来源、Cookie 与传输边界见上方部署说明。使用域名、公共网络或公网访问时，必须由部署者提供加密入口，并确保 `PUBLIC_ORIGIN` 与浏览器实际来源一致。

常用运维命令：

```bash
docker compose -p movie-harbor ps
docker compose -p movie-harbor logs -f api caddy
docker compose -p movie-harbor restart
docker compose -p movie-harbor pull
docker compose -p movie-harbor up -d --build --wait
```

`docker compose down` 不会删除当前通过 bind mount 保存的数据库和媒体目录；真正的数据边界是 `DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 指向的宿主机路径。不要在未完成一致备份时删除、清空或改指这两个目录。

## 半离线发布包

构建机需要 Docker Engine、Docker Buildx、Docker Compose v2、Node.js、Git 和 tar，并能下载构建依赖。原生 AMD64 Linux 是生成 AMD64 发布包的首选；在其他架构上构建依赖 Docker/BuildKit 的模拟支持。工具按指定平台构建并校验最终镜像元数据，Docker 守护进程的架构无需与目标平台相同。在仓库根目录执行：

```bash
./tools/build-offline-package.sh [版本]                       # 默认 linux/arm64
./tools/build-offline-package.sh --platform linux/amd64 [版本] # Intel/AMD 64 位 Linux
# npm 入口透传相同参数，例如：
npm run package:offline -- --platform linux/amd64 [版本]
```

`[版本]` 是可选参数，使用时替换为实际版本字符串并去掉方括号；省略时使用当前 Git 提交的 12 位短 SHA。也可显式指定 `--platform linux/arm64`。产物写入 `dist/offline/`，两个平台分别生成 `movie-harbor-offline-linux-arm64-<版本>.tar.gz` 和 `movie-harbor-offline-linux-amd64-<版本>.tar.gz`；同名产物已存在时构建会拒绝覆盖。每个归档只包含所选平台的三个自研镜像。

包中只内置 API、公开站、管理后台这 3 个自研镜像。目标机仍必须能访问 Docker Hub 获取 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`，因此不支持完全断网部署。包内 Compose 使用固定版本的本地自研镜像且不包含源码构建上下文，启动时不会拉取或构建自研镜像。

目标机需要 64 位 Linux、Docker Engine 和 Docker Compose v2。Intel/AMD 64 位 Ubuntu 必须选择 `linux/amd64` 包；ARM64 Linux 选择 `linux/arm64` 包。将对应发布包复制到目标机后，解压到部署目录并执行（下例使用 AMD64 包；ARM64 部署时将归档名中的 `linux-amd64` 改为 `linux-arm64`）：

```bash
tar -xzf movie-harbor-offline-linux-amd64-<版本>.tar.gz
cd movie-harbor
./load-images.sh
cp .env.example .env
# 编辑 .env：替换密码与代理秘密并核对数据目录；默认仅本机管理。可信局域网 HTTP 须显式开启 ALLOW_INSECURE_LAN_HTTP；正式部署须按上文配置 HTTPS。
docker compose --env-file .env config
docker compose up -d --no-build --wait
```

`load-images.sh` 先用 `sha256sum` 校验包内文件，再导入镜像并验证三个精确标签与包声明的平台一致；目标机需要提供该命令。校验用于检查文件完整性，分发时还应通过可信渠道核对外层归档的 SHA-256。包内的默认本机、显式可信局域网 HTTP 和正式 HTTPS 配置，以及初始管理员和代理秘密要求，均与上述生产部署说明一致。

`DATABASE_HOST_DIR` 映射到 PostgreSQL 的 `/var/lib/postgresql/data`，`MEDIA_HOST_DIR` 映射到 API 的 `/media` 和 Caddy 的只读 `/srv/media`。默认分别为解压目录下的 `./data/postgres` 和 `./data/media`；建议改为固定的宿主机绝对路径，以便升级时复用同一套数据。初始化容器会设置媒体目录的属主和权限。

升级前停止写入，并将数据库和媒体目录作为同一个一致性备份集保存；新包导入后，复用原有数据目录、部署项目名和经过核对的环境配置，再执行启动命令。包不包含真实 `.env`、密码、数据库、媒体数据、源码或开发依赖；备份与秘密须由部署者单独保管。停止本部署使用 `docker compose down`，不要删除仍需保留的数据目录。

## 上传格式与容量

- 海报：JPEG、PNG、WebP。后端同时检查扩展名、MIME 和实际图片内容。
- 支持 WebM。
- 支持 H.264 MP4。
- 支持 HEVC MP4 的 `hvc1`、`hev1` 样本项。
- 实际播放能力仍取决于访问者浏览器和操作系统对 HEVC 的支持；服务不会自动转码。
- `MAX_UPLOAD_BYTES` 是单文件上限，默认值为 50 GiB（`53687091200` 字节），不是媒体库总容量或推荐文件大小。规划磁盘时需同时预留正式媒体、上传临时文件和替换期间新旧文件的空间。
- `/media` 是公开 URL，支持浏览器 Range 请求，但不提供防下载、DRM 或可靠防盗链。

## 一致备份与恢复

数据库元数据和 `MEDIA_HOST_DIR` 媒体目录必须作为同一个一致性备份集处理，只备份其中一项会产生丢失引用或孤立文件。稳妥的单机流程是在维护窗口停止 API 写入，同时导出数据库并归档媒体目录。下面假设 `.env` 中的 `MEDIA_HOST_DIR` 已改为宿主机绝对路径：

```bash
docker compose -p movie-harbor stop api
docker compose -p movie-harbor exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > movie-harbor-db.dump
MEDIA_BACKUP_SOURCE=/absolute/path/from-MEDIA_HOST_DIR
docker run --rm --mount type=bind,src="$MEDIA_BACKUP_SOURCE",dst=/source,readonly --mount type=bind,src="$PWD",dst=/backup alpine:3.22 tar -C /source -czf /backup/movie-harbor-media.tgz .
docker compose -p movie-harbor start api
```

恢复时先停止 API，将数据库恢复到空库，并把媒体归档解压回 `MEDIA_HOST_DIR` 指向的目录；确认两者来自同一备份点、媒体目录属主仍为 UID/GID `10001:10001` 且权限为 `0700` 后再启动 API。备份文件包含私有内容与密码哈希，应加密保存并定期演练恢复。`DATABASE_HOST_DIR` 的 PostgreSQL 文件不能替代逻辑导出直接跨版本复制。

## 开发与验收

源码开发需要 Rust stable（支持 Rust 2024 edition）、Node.js 24、npm、Docker Engine 和 Docker Compose v2。首次进入仓库先安装前端依赖并启动隔离测试数据库：

```bash
npm install
docker compose -f docker-compose.test.yml up -d postgres
```

单元测试与构建：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace
npm test --workspaces
npm run build --workspaces
```

旧版测试曾在中断时遗留按测试套件命名的 schema。确认没有 Movie Harbor 测试正在运行后，可用 `psql "$TEST_DATABASE_URL" -f backend/tests/cleanup_test_schemas.sql` 仅清理本项目已知前缀的遗留 schema；脚本不会匹配其他项目或普通业务 schema。

完整 E2E 会为每次运行生成以 `mh-task15-e2e-` 开头的唯一 Compose 项目名，并在被忽略的 `tests/e2e/.generated/runs/` 下创建带所有权标记的唯一运行目录。该目录内的 PostgreSQL 与媒体子目录会被显式传给 Compose 和 Playwright；验证生命周期与持久化后，runner 先正常停止该轮服务，再用只挂载这两个已验证 bind 目录的临时 root 容器清空容器属主文件。该步骤成功后才会 down 精确项目，并由宿主重新验证所有权标记和路径后删除已清空的本轮目录。测试不会读取或修改生产默认的 `data/postgres` 和 `data/media`；若容器内清理失败，runner 会保留已停止的项目与目录并明确报错，不会尝试宿主权限兜底。

```bash
npx playwright install chromium
npm run test:e2e
```

设置 `E2E_KEEP=1` 可在失败后跳过全部清理，保留隔离容器和本轮目录供排查；runner 会在终端打印本轮的完整项目名、绝对运行目录、媒体目录和数据库目录。人工收尾时也必须遵循 runner 的顺序：先停止该精确项目，再用临时 root 容器只挂载并清空输出中的媒体和数据库目录、恢复宿主权限，成功后才 down 项目并删除对应的本轮运行目录。不要先 down 后直接用宿主递归删除容器属主目录，也不要把生产默认目录传给清理容器。

## 查看 UI Demo

Demo 使用模拟数据，用于审核访客首页、管理后台和添加剧集页面，不连接真实后端。

在项目根目录执行：

```bash
python3 -m http.server 4173 --directory demo --bind 127.0.0.1
```

服务启动后，可访问以下页面：

- 访客首页：http://127.0.0.1:4173/?view=home
- 管理后台：http://127.0.0.1:4173/?view=admin
- 添加剧集：http://127.0.0.1:4173/?view=series-editor

停止服务时，在运行服务的终端按 `Ctrl+C`。

如果 `4173` 端口已被占用，可以更换端口，例如：

```bash
python3 -m http.server 4174 --directory demo --bind 127.0.0.1
```

此时将访问地址中的端口同步改为 `4174`。

## 目录结构

```text
backend/                    Axum API、迁移与后端测试
backend/src/admin_content/  电影与剧集统一管理列表和分页
backend/src/admin_export/   全量内容只读快照与 JSON 导出
backend/src/content.rs      跨内容类型的字段与生命周期基础规则
backend/src/route_params.rs 公共 UUID 路由参数解析
frontend/public-web/        公开 React 应用
frontend/admin-web/         管理后台 React 应用
frontend/packages/          共享 API 客户端与 UI
tests/e2e/                  Playwright 跨服务验收
demo/                       已审核的静态 UI Demo
tools/                      半离线发布包构建入口与核心工具
dist/offline/               构建生成且被 Git 忽略的半离线归档输出目录
docs/superpowers/           产品规格与实现计划
```

## 首版不包含

- 自动转码和码率自适应。
- 外挂字幕管理。
- 多管理员或角色权限。
- 服务端观看历史、收藏、评分和评论。
- 第三方元数据导入。
- S3、MinIO 等对象存储。
- 防下载、数字版权保护或可靠的防盗链。
