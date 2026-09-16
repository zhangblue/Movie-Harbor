# Movie Harbor

Movie Harbor 是一个面向个人或小型团队、可自行部署的电影与剧集媒体库。访客无需登录即可浏览、搜索和播放已发布内容；单一管理员通过独立后台维护电影、剧集、季、单集、题材、海报和视频。

快速入口：[生产部署](#生产部署) · [半离线发布包](#半离线发布包) · [备份与恢复](#一致备份与恢复) · [开发与验收](#开发与验收) · [项目文档](#项目文档)

## 当前状态

- 产品设计：已确认。
- UI Demo：已确认，保存在 `demo/`。
- 生产应用：已实现，可通过 Docker Compose 自托管。
- 内容列表：管理后台统一分页电影与剧集，公开站与管理后台均固定每页 20 条并支持数字页码。
- 媒体能力：支持多存储卷、同步删除与替换、启动恢复、H.264/HEVC MP4 和 WebM。
- 发布工具：支持分别生成 `linux/arm64` 与 `linux/amd64` 两个单平台半离线 Docker 部署包；AMD64 包面向 Windows 11 64 位 Intel/AMD + Docker Desktop Linux containers。

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
- [本机默认配置一致性](docs/superpowers/specs/2026-09-13-default-local-config-design.md)
- [HEVC MP4 上传与中文错误反馈](docs/superpowers/specs/2026-09-14-hevc-mp4-upload-and-localized-error-design.md)
- [管理与公开内容列表分页](docs/superpowers/specs/2026-09-15-admin-and-public-content-pagination-design.md)
- [前后端公共函数提取](docs/superpowers/specs/2026-09-15-common-function-extraction-design.md)
- [多存储卷媒体设计](docs/superpowers/specs/2026-09-16-multi-volume-media-storage-design.md)与[实现计划](docs/superpowers/plans/2026-09-16-multi-volume-media-storage.md)
- [Windows 11 AMD64 半离线包设计](docs/superpowers/specs/2026-09-16-windows11-amd64-offline-package-design.md)、[实现计划](docs/superpowers/plans/2026-09-16-windows11-amd64-offline-package.md)与[验收记录](docs/verification/windows11-amd64-package.md)

完整设计和实施记录位于 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。

## 媒体目录安全边界

`MEDIA_DIRS` 中的每个媒体目录必须由后端进程的 OS 账号拥有，且不可对组用户或其他用户开放写权限。后端会在启动时验证该条件，并以 `0700` 创建私有 `.quarantine` 目录；权限不安全时会拒绝启动。部署时不得让其他服务共享该 OS 账号或获得媒体目录写权限。同一 OS 账号下运行的恶意进程能够修改应用自有文件，因此位于本地文件存储的信任边界内。直接运行后端时使用分号分隔的 `MEDIA_DIRS`；旧的单卷 `MEDIA_DIR` 仅作为未设置 `MEDIA_DIRS` 时的兼容配置。

Compose 会先用一次性初始化容器把媒体卷根目录交给专用的 API 用户，设为 UID/GID `10001:10001`、权限 `0711`；非秘密卷标记使用 `0644`，让普通部署用户能够读取已知标记路径，但不能列举或写入卷根。API 以 UID `10001` 读写媒体卷；入口 Caddy 仅以只读方式挂载同一卷。`.incoming`、`.quarantine` 和 `.operations` 保持 `0700`，不得递归放宽目录或媒体文件权限。旧版根目录为 `0700` 的单卷部署须先执行下文的[一次性升级](#旧单卷部署的一次性升级)。

每个 `media_asset` 在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能被多个槽位共享。删除电影、剧集、季或单集时，API 会在同一请求内暂存对应文件、提交数据库删除并移除物理文件；替换海报或视频时也会在成功响应前同步移除旧媒体记录与旧文件。成功响应表示本次对应的数据库记录和物理文件均已处理，不需要另行等待垃圾回收。

系统不运行周期媒体垃圾回收任务。启动恢复只处理删除或替换请求在中断前已经写入持久清单的操作：数据库仍引用的文件会恢复到公开路径，已不再引用的隔离文件会完成删除；它不会扫描或自动删除任意孤立文件。因此数据库和媒体目录仍须作为一致的整体运维。

### 升级到数据库迁移 v5

迁移 v5 会把媒体所有权改为全局独占，并移除旧的 `file_cleanup_job` 周期清理队列。升级前必须先备份数据库和媒体目录，确认 `file_cleanup_job` 为空，并检查电影海报、电影视频、剧集海报和单集视频的全部引用；任何被多个槽位共享的媒体都必须先复制为各自独立的媒体记录和物理文件，再更新对应引用。迁移检测到待处理清理任务或共享引用时会拒绝升级，不会静默丢弃任务或猜测文件归属。

## 生产部署

要求安装 Docker Engine、Docker Compose v2 和 Node.js 24 或更新版本。复制环境变量示例并替换密码与代理秘密；非本机部署还需按实际入口配置来源和 Cookie 安全选项。媒体目录必须事先存在；以下用于新部署，旧单卷部署请先完成[一次性升级](#旧单卷部署的一次性升级)：

```bash
cp .env.example .env
# 仅新部署：按 .env 中配置的路径创建目录；默认配置如下。
mkdir -p data/media
./tools/start-compose.sh
```

默认本机入口是 `http://localhost:8080`。如果修改 `APP_PORT`，或实际使用其他主机名、IP、端口或协议访问，必须把 `PUBLIC_ORIGIN` 同步改为浏览器实际使用的完整来源。公开站位于 `/`，管理后台位于 `/admin/`，API 位于 `/api/`，媒体位于 `/media/`。PostgreSQL 不暴露宿主端口。

首次启动时，API 自动执行数据库迁移。只有数据库内尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号；之后修改 `.env` 或重启容器都不会覆盖已有管理员名称和密码。首次登录并修改密码后，应从 `.env` 移除初始凭据或换成无意义的占位值，但其余必填变量仍须保留。

关键环境变量：

| 变量 | 示例默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8080` | 宿主机入口端口；修改后同步调整 `PUBLIC_ORIGIN`。 |
| `DATABASE_HOST_DIR` | `./data/postgres` | PostgreSQL 宿主机持久目录。 |
| `MEDIA_HOST_DIR` | `./data/media` | 分号分隔的有序宿主媒体目录列表；多卷必须使用绝对路径。 |
| `MEDIA_DISK_RESERVE_BYTES` | `10737418240` | 每卷安全保留空间，默认 10 GiB，必须是正整数。 |
| `POSTGRES_DB` / `POSTGRES_USER` | `movie_harbor` | Compose 使用的数据库名与账号。 |
| `POSTGRES_PASSWORD` | 无安全默认值 | 必须替换为随机数据库密码。 |
| `ADMIN_NAME` / `ADMIN_INITIAL_PASSWORD` | `admin` / 无安全默认值 | 仅在空库首次创建管理员时使用。 |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | 必须与浏览器实际访问来源完全一致。 |
| `COOKIE_SECURE` | `false` | 只允许 localhost 或环回 HTTP；正式部署必须设为 `true`。 |
| `TRUST_PROXY_SECRET` | 无安全默认值 | Caddy 与 API 之间的独立代理认证秘密，至少 32 字节。 |
| `MAX_UPLOAD_BYTES` | `53687091200` | 单文件上限，默认 50 GiB。 |
| `VIDEO_MIME_ALLOWLIST` | `video/mp4,video/webm` | 允许进入结构化格式校验的视频 MIME。 |

数据库连接必须二选一：直接运行 API 时可只设置 `DATABASE_URL`；Compose 使用 `DATABASE_HOST`、`DATABASE_PORT`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 这组分项变量。为避免迁移和运行时误连不同数据库，两种方式同时出现时 API 会拒绝启动。

登录限流默认只信任 API 连接的对端地址，并忽略客户端提供的 `X-Forwarded-For`。标准 Compose 不向宿主机暴露 API，由 Caddy 覆盖该请求头为实际客户端地址，并用独立的 `TRUST_PROXY_SECRET` 向 API 认证代理身份。请把示例值替换为至少 32 字节的随机秘密且不要复用其他密码。仅当 API 只能由持有该秘密且会覆盖（而非追加）该请求头的受信反向代理访问时才可开启 `TRUST_PROXY_HEADERS`；直接暴露 API 时必须保持关闭。

示例配置显式使用 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，只适用于通过 `localhost` 或环回地址进行本机 HTTP 访问；如果改用 `http://127.0.0.1:8080`，也必须把 `PUBLIC_ORIGIN` 改为该实际来源。使用域名、局域网地址或公网地址的正式部署必须配置实际的 `https://` 来源、设置 `COOKIE_SECURE=true`，并由部署者用域名、上游反向代理或自己的 TLS 终止层启用 HTTPS。不要在公网或局域网以明文 HTTP 提供管理后台。

常用运维命令：

```bash
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env ps
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env logs -f api caddy
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env restart
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env pull
./tools/start-compose.sh
```

`docker compose down` 不会删除当前通过 bind mount 保存的数据库和媒体目录；真正的数据边界是 `DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 指向的宿主机路径。不要在未完成一致备份时删除、清空或改指这两个目录。

### 多卷初始化与扩容

`.env` 没有原生数组类型，`MEDIA_HOST_DIR` 使用分号表达有序数组，例如 `MEDIA_HOST_DIR=/mnt/disk1/movie-harbor;/mnt/disk2/movie-harbor`。单路径仍有效；禁止空项、重复目录、符号链接根目录和包含分号的目录名。列表位置就是稳定卷编号 `0、1、2…`，上线后只能在末尾追加，不能删除、替换或重排已有项。Windows Docker Desktop 路径使用正斜杠（如 `D:/MovieHarbor/media;E:/MovieHarbor/media`），需在相应 Windows 环境完成多物理盘验收；当前源码启动入口是 POSIX shell。

`./tools/start-compose.sh` 在 `.env` 所在的部署目录保存被 Git 忽略的 `.movie-harbor-storage-state.json` 卷登记记录，记录版本与按编号排列的规范路径，不包含密码。入口先校验全部已登记路径和 `.movie-harbor-volume.json` 身份标记，再以文件同步、原子替换和目录同步保存登记，最后生成 `compose.storage.generated.json` 并启动 Docker。普通重启不重建标记；已有卷缺标记，即使挂载点为空，也会直接失败。

旧单卷使用下文专用入口登记为卷 0；数据库迁移在后续普通启动时把旧记录归到卷 0，不移动原文件。后续只允许在末尾追加没有标记的空目录。登记记录缺失但发现已有标记或生成配置时，以及记录损坏或普通初始化中断时，入口拒绝继续；应核对磁盘和配置并恢复可信登记备份，不能删掉登记或改标记编号来绕过校验。专用升级中断留下的 pending 登记只能由专用入口继续，普通启动仍拒绝执行。纯生成配置用于预览时，请使用独立输出文件，避免把它作为已启动部署的输出。

每个目录分别映射到 API/初始化容器的 `/media/volumes/<编号>` 和 Caddy 只读的 `/srv/media/volumes/<编号>`。初始化只将卷根设置为 UID/GID `10001:10001`、权限 `0711`，让普通宿主用户可以读取已知路径上的非秘密标记（`0644`），不能列举或写入卷根；内部临时、隔离及操作目录继续为 `0700`，媒体文件权限不变。公开地址形如 `/media/v0/video/ab/<文件标识>.mp4`；卷标记、`.incoming`、`.quarantine` 与操作清单不会公开。

扩容时先用上述两个 Compose 文件停止服务，确认所有原盘在线，在配置末尾追加已挂载且为空的新目录，再运行启动入口重新创建容器。新上传会选择扣除安全保留空间与进行中上传预留量后，可用空间最多的健康卷；同一文件系统的逻辑卷共享一次容量采样、安全保留空间和上传预留，容量相同时优先编号较小的卷。系统不热插拔、不拆分单文件、不迁移或重新平衡旧文件。

遇到缺盘、标记不符、顺序变化或数据库引用未配置卷时，API 拒绝启动。应停止服务，检查磁盘挂载和原始配置，并从同一备份点恢复身份标记与数据；不要在缺盘挂载点创建空目录冒充原盘。运行中某卷不可用时，新上传可以选择其他健康卷，但涉及故障卷旧文件的替换或删除会失败并保留数据库状态。收到存储空间不足提示时，先释放空间、恢复卷或按上述流程追加卷；不要直接删除受管理的媒体文件或清空内部恢复目录。

### 旧单卷部署的一次性升级

旧版初始化会把媒体根设置为 UID/GID `10001:10001`、权限 `0700`，普通 Docker 用户无法在其中读取或创建新卷标记。升级须使用 `./tools/upgrade-media-storage.sh --confirm-existing-volume-zero`；该确认表示你已核对路径对应原来的媒体卷 0。运行者需要使用 Docker 的权限，宿主脚本不需要以 root 执行。

先在旧版部署中停止 API 写入，按原部署配置完成数据库与整个媒体目录的一致备份，包含隐藏文件，并保留原 `.env`、项目名和 Compose 配置。确认备份可恢复后，使用仍在运行的旧版本配置停止全部服务；如原部署使用自定义 `-p`、`-f` 或环境文件，须沿用它们：

```bash
# 在旧版部署目录执行；此时已停止写入并完成一致备份。
docker compose --env-file .env stop
```

然后更新源码，保留原 `.env`，保持 `MEDIA_HOST_DIR` 恰好一个原路径且原盘在线；本次不要追加新卷，也不要为升级创建空目录。旧根中须仍有至少一个真实的 `.incoming`、`.quarantine`、`.operations`、`video` 或 `poster` 目录。空目录、只有标记或升级临时文件的目录均不会被认领；合法旧目录若不满足该条件，也须先核对原盘和备份，不能靠创建占位目录绕过检查。

在更新后的项目根目录执行：

```bash
./tools/upgrade-media-storage.sh --confirm-existing-volume-zero
# 仅升级成功后执行；此时才生成覆盖配置、启动服务并运行数据库迁移。
./tools/start-compose.sh
```

自定义环境文件时，两次命令必须指向同一个文件；相对单卷路径按该文件所在目录解析：

```bash
MOVIE_HARBOR_ENV_FILE=/absolute/path/to/deployment.env ./tools/upgrade-media-storage.sh --confirm-existing-volume-zero
MOVIE_HARBOR_ENV_FILE=/absolute/path/to/deployment.env ./tools/start-compose.sh
```

专用入口先在环境文件所在目录持久保存 pending 登记，再用固定 `alpine:3.22` 临时 root 容器校验原根和标记。容器只将根设为 `10001:10001`、`0711`，将卷 0 标记设为 `0644`；不递归修改权限，不迁移、复制或删除媒体，也不改变三个私有目录的内容和权限。已有标记必须通过身份校验，错误标记不会被覆盖。升级入口不会启动应用服务，成功后才将 pending 转为正常登记，并提示执行普通启动入口。

如果升级中断，保留 pending 登记和全部卷内文件，确认原盘在线、路径不变且旧服务仍已停止，然后重新执行同一条专用升级命令。pending 记录原根的设备与 inode 身份；同路径被换成其他目录、登记损坏、标记错误或旧卷结构缺失时，重试仍会拒绝。普通 `start-compose.sh` 不会修复 pending。已完成的正常登记拒绝再次升级，后续直接普通启动；登记丢失或损坏时恢复可信备份，不要手工删除登记重新认领卷。

## 半离线发布包

构建工具生成两个彼此独立的单平台包，不会把 ARM64 与 AMD64 镜像放进同一个归档。构建机需要 Docker、Buildx、Docker Compose v2、Node.js、Git 和 tar，并能下载构建依赖；正式 AMD64 交付应在原生 AMD64 Linux 构建机或 CI runner 上生成并保留平台检查证据。在仓库根目录执行：

```bash
./tools/build-offline-package.sh --platform linux/arm64 [版本]
./tools/build-offline-package.sh --platform linux/amd64 [版本]

# 等价的 npm 入口：
npm run package:offline -- --platform linux/arm64 [版本]
npm run package:offline -- --platform linux/amd64 [版本]
```

`[版本]` 是可选参数，使用时替换为实际版本字符串并去掉方括号；省略时使用当前 Git 提交的 12 位短 SHA。不传 `--platform` 时为兼容旧调用，默认仍构建 `linux/arm64`。产物分别写入：

```text
dist/offline/movie-harbor-offline-linux-arm64-<版本>.tar.gz
dist/offline/movie-harbor-offline-linux-amd64-<版本>.tar.gz
```

同平台同版本产物已存在时构建会拒绝覆盖。Apple Silicon 可以尝试模拟构建 AMD64，但模拟结果不能代替原生 AMD64 构建证据。

包中只内置 API、公开站、管理后台这 3 个自研镜像。目标机仍必须能访问 Docker Hub 获取 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`，因此不支持完全断网部署。包内 Compose 使用固定版本的本地自研镜像且不包含源码构建上下文，启动时不会拉取或构建自研镜像。

### ARM64 Linux 部署

ARM64 目标机需要 Node.js、Docker Engine、Docker Compose v2，并以 Linux containers 运行。复制归档后执行：

```bash
tar -xzf movie-harbor-offline-linux-arm64-<版本>.tar.gz
cd movie-harbor
./load-images.sh
cp .env.example .env
# 编辑 .env：替换密码与代理秘密，核对数据库目录和全部媒体目录。
./start.sh
```

`load-images.sh` 先用 `sha256sum` 校验包内文件，再导入并验证三个 `linux/arm64` 镜像。`start.sh` 使用与 Windows 入口一致的卷登记、只允许末尾追加和存储覆盖生成规则，再以固定 Compose 文件启动；不要绕过它直接运行单个 Compose 文件。

如果是旧版 Linux 单卷半离线部署，原媒体根可能已被设为 `10001:10001`、`0700`，普通宿主用户不能直接用 `start.sh` 完成首次登记。先停止旧服务，对数据库、整个原媒体目录和原 `.env` 做一致备份；在新包目录保留原 `.env`，确保 `MEDIA_HOST_DIR` 仍只有原目录且原盘在线，然后执行：

```bash
./upgrade-media-storage.sh --confirm-existing-volume-zero
./start.sh
```

包内 `upgrade-media-storage.sh`、`upgrade-media-storage.mjs` 与 `storage-compose.mjs` 是专用的一次性升级入口；它只登记原卷 0 并修正卷根与标记权限，不递归修改或迁移媒体，也不会启动应用。升级中断时保留 pending 和原数据，核对原盘后重跑同一条升级命令。新部署、已经正常登记的部署以及 Windows PowerShell 部署不得运行该 shell 入口。Linux AMD64 主机使用 AMD64 包时遵循同一流程。

### Windows 11 AMD64 部署

目标电脑必须是 Windows 11 64 位，CPU 为 Intel/AMD x86-64（用户目标机 Intel i7-8700K 满足架构要求），并安装 Docker Desktop。Docker Desktop 必须启用 WSL2 后端、切换到 Linux containers 模式且提供 Docker Compose v2；本包不支持 Windows containers、Windows on ARM 或 32 位 Windows。还需在 Docker Desktop 中允许 Linux VM 访问数据库和每个媒体盘目录。

把 `movie-harbor-offline-linux-amd64-<版本>.tar.gz` 复制到目标电脑，在 Windows PowerShell 5.1 或更高版本中执行：

```powershell
tar -xzf movie-harbor-offline-linux-amd64-<版本>.tar.gz
Set-Location movie-harbor
.\load-images.ps1
Copy-Item .env.example .env
# 编辑 .env：替换全部密码和 TRUST_PROXY_SECRET，并设置现存的数据目录。
# Windows 绝对盘符路径统一使用正斜杠；多个媒体卷以分号分隔：
# DATABASE_HOST_DIR=D:/MovieHarbor/postgres
# MEDIA_HOST_DIR=D:/MovieHarbor/media;E:/MovieHarbor/media
.\start.ps1
```

`load-images.ps1` 会先验证 `SHA256SUMS` 精确覆盖的全部包内文件，校验失败时不会导入镜像；随后导入并确认三个自研镜像均为 `linux/amd64`。`start.ps1` 只按文本读取 `.env` 中首次出现的 `DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR`，不会执行其中内容。它先要求数据库目录是现存、可写、非 UNC、非通配符或重解析点的本地绝对盘符路径，再校验媒体目录；数据库目录无效时不会创建媒体登记、卷标记或生成覆盖文件。随后它会拒绝 Windows containers、缺失盘符或目录、无写权限、卷身份不符和不安全路径，再生成 `compose.storage.generated.json` 并等待服务健康。首次部署前必须手动创建配置中的数据库和媒体目录，并把 `.env.example` 的相对数据库默认值改为上方展示的绝对盘符路径；脚本不会把缺失盘符静默替换成其他位置。

`MEDIA_HOST_DIR` 是有序卷数组。部署后只允许在末尾追加一个已挂载、现存且为空的新目录；不得删除、替换或重排已有路径，也不要删除 `.movie-harbor-storage-state.json` 或各卷的 `.movie-harbor-volume.json`。系统不支持运行中热插拔；扩容前应停止写入并对数据库、登记文件和全部媒体卷做一致备份。

### 访问、安全与失败恢复

默认 `PUBLIC_ORIGIN=http://localhost:8080` 与 `COOKIE_SECURE=false` 只适用于目标机本机访问。管理后台位于 `/admin/`。通过其他电脑、局域网 IP、域名或公网访问时，不要直接使用明文 HTTP：应配置实际的 `https://` 来源、设置 `COOKIE_SECURE=true`，并通过域名证书或上游 TLS 终止层把 HTTPS 请求转发到包内 Caddy。

如果校验或镜像导入失败，保留原归档，重新从可信渠道复制并重新执行对应的 `load-images` 脚本；不要跳过校验。如果 `start.sh` 或 `start.ps1` 失败，不要删除数据库、媒体文件、卷标记、登记文件或生成配置来强行重试。先根据错误恢复原硬盘、Docker Linux containers、目录权限或原 `.env` 卷顺序，再执行同一个启动入口重试。升级失败时继续使用同一部署目录、`.env` 和卷顺序；必要时从同一备份点恢复数据库、`.movie-harbor-storage-state.json` 与全部媒体卷。

校验清单只能证明包内文件传输后未损坏；仍应通过可信渠道核对外层归档 SHA-256。包不包含真实 `.env`、密码、数据库、媒体数据、源码或开发依赖。升级前停止写入并进行一致备份，新包导入后复用原数据目录、部署目录、`.env`、卷顺序和项目状态。停止部署可在包目录用基础 Compose 与生成覆盖文件执行 `docker compose --env-file .env -f compose.yml -f compose.storage.generated.json down`；不要添加 `--volumes`，也不要删除仍需保留的数据目录。

## 上传格式与容量

- 海报：JPEG、PNG、WebP。后端同时检查扩展名、MIME 和实际图片内容。
- 支持 WebM。
- 支持 H.264 MP4。
- 支持 HEVC MP4 的 `hvc1`、`hev1` 样本项。
- 实际播放能力仍取决于访问者浏览器和操作系统对 HEVC 的支持；服务不会自动转码。
- `MAX_UPLOAD_BYTES` 是单文件上限，默认值为 50 GiB（`53687091200` 字节），不是媒体库总容量或推荐文件大小。规划磁盘时需同时预留正式媒体、上传临时文件和替换期间新旧文件的空间。
- `MEDIA_DISK_RESERVE_BYTES` 对每卷保留 10 GiB（可配置正整数），缺少请求长度时按 `MAX_UPLOAD_BYTES` 为本次上传预留容量；即使文件很小，也必须有足够的保守预留空间。
- `/media` 是公开 URL，支持浏览器 Range 请求，但不提供防下载、DRM 或可靠防盗链。

## 一致备份与恢复

数据库元数据、部署目录内的 `.movie-harbor-storage-state.json` 和 `MEDIA_HOST_DIR` 中的全部媒体卷必须作为同一个一致性备份集处理，只备份部分卷会产生丢失引用或孤立文件。维护窗口中先停止 API 写入，导出数据库，保存卷登记记录，逐卷归档全部内容（包括隐藏的身份标记与恢复清单），并记录卷顺序和配置。所有卷归档完成后才能恢复写入。下面展示卷 0 的备份命令；多卷部署需为每个实际目录重复归档步骤，并使用各自独立文件名：

```bash
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env stop api
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > movie-harbor-db.dump
MEDIA_BACKUP_SOURCE=/absolute/path/to/volume-0
docker run --rm --mount type=bind,src="$MEDIA_BACKUP_SOURCE",dst=/source,readonly --mount type=bind,src="$PWD",dst=/backup alpine:3.22 tar -C /source -czf /backup/movie-harbor-media-v0.tgz .
# 此时继续归档其余所有媒体卷，全部完成后再启动 API。
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env start api
```

恢复时先停止 API，将数据库恢复到空库，把每卷归档解压回对应的原逻辑卷位置，同时恢复部署目录中的卷登记记录、全部身份标记和配置顺序；确认数据库与全部媒体卷来自同一备份点、媒体根属主仍为 UID/GID `10001:10001` 且权限为 `0711`、内部临时/隔离/操作目录为 `0700` 后，重新生成覆盖配置并启动。启动恢复只处理有持久清单的中断操作，不会扫描或删除普通孤立文件。备份文件包含私有内容与密码哈希，应加密保存并定期演练恢复。`DATABASE_HOST_DIR` 的 PostgreSQL 文件不能替代逻辑导出直接跨版本复制。

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

完整 E2E 会为每次运行生成以 `mh-task15-e2e-` 开头的唯一 Compose 项目名，并在被忽略的 `tests/e2e/.generated/runs/` 下创建带所有权标记的唯一运行目录。该目录内包含 PostgreSQL、`media-0`、`media-1`、卷标记和 Compose 存储覆盖配置，显式覆盖继承的生产存储变量。真实浏览器验证上传、播放、替换、删除和重启；两个媒体目录位于同一文件系统时，同容量按规则落到卷 0。跨卷容量差异与回滚由 Rust 测试注入容量探针覆盖，真实不同物理盘的 Linux/Windows 验收另行执行，不向生产环境添加伪造容量开关。验证后 runner 停止该轮服务，再用只挂载三个已验证 bind 目录的临时 root 容器清空容器属主文件；成功后才 down 精确项目并重新验证所有权、路径和目录身份，删除本轮目录。测试不会读取或修改生产默认的 `data/postgres` 和 `data/media`；清理失败会保留项目与目录并明确报错。

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
