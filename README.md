# Movie Harbor

Movie Harbor 是一个面向个人或小型团队、可自行部署的电影与剧集媒体库。访客无需登录即可浏览、搜索和播放已发布内容；单一管理员通过独立后台维护电影、剧集、季、单集、题材、海报和视频。

## 当前状态

- 产品设计：已确认。
- UI Demo：已确认，保存在 `demo/`。
- 实现计划：已完成。
- 生产代码：已实现，可通过 Docker Compose 自托管。

## 核心设计

- 内容支持电影和“剧集 → 季 → 集”两种结构。
- 电影、剧集和单集具有草稿、已发布、已归档状态，只有草稿可以编辑。
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

- [产品设计规格](docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md)
- [实现计划](docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md)
- [协作约定](AGENTS.md)

## 媒体目录安全边界

`MEDIA_DIR` 必须由后端进程的 OS 账号拥有，且不可对组用户或其他用户开放写权限。后端会在启动时验证该条件，并以 `0700` 创建私有 `.quarantine` 目录；权限不安全时会拒绝启动。部署时不得让其他服务共享该 OS 账号或获得媒体目录写权限。同一 OS 账号下运行的恶意进程能够修改应用自有文件，因此位于本地文件存储的信任边界内。

Compose 会先用一次性初始化容器把媒体卷根目录交给专用的 API 用户，并设为 `0700`。API 以 UID `10001` 读写媒体卷；入口 Caddy 仅以只读方式挂载同一卷。若改用宿主机目录绑定，请先执行 `chown 10001:10001 <目录>` 和 `chmod 0700 <目录>`，且不要把该目录写权限授予其他服务。

每个 `media_asset` 在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能被多个槽位共享。删除电影、剧集、季或单集时，API 会在同一请求内暂存对应文件、提交数据库删除并移除物理文件；替换海报或视频时也会在成功响应前同步移除旧媒体记录与旧文件。成功响应表示本次对应的数据库记录和物理文件均已处理，不需要另行等待垃圾回收。

系统不运行周期媒体垃圾回收任务。启动恢复只处理删除或替换请求在中断前已经写入持久清单的操作：数据库仍引用的文件会恢复到公开路径，已不再引用的隔离文件会完成删除；它不会扫描或自动删除任意孤立文件。因此数据库和媒体目录仍须作为一致的整体运维。

### 升级到数据库迁移 v5

迁移 v5 会把媒体所有权改为全局独占，并移除旧的 `file_cleanup_job` 周期清理队列。升级前必须先备份数据库和媒体目录，确认 `file_cleanup_job` 为空，并检查电影海报、电影视频、剧集海报和单集视频的全部引用；任何被多个槽位共享的媒体都必须先复制为各自独立的媒体记录和物理文件，再更新对应引用。迁移检测到待处理清理任务或共享引用时会拒绝升级，不会静默丢弃任务或猜测文件归属。

## 生产部署

要求安装 Docker Engine 与 Docker Compose v2。复制环境变量示例并替换所有密码和域名：

```bash
cp .env.example .env
docker compose -p movie-harbor up -d --build --wait
```

默认入口是 `http://服务器地址:8080`，可通过 `APP_PORT` 修改宿主端口。公开站位于 `/`，管理后台位于 `/admin/`，API 位于 `/api/`，媒体位于 `/media/`。PostgreSQL 不暴露宿主端口。

首次启动时，API 自动执行数据库迁移。只有数据库内尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号；之后修改 `.env` 或重启容器都不会覆盖已有管理员名称和密码。首次登录并修改密码后，应从 `.env` 移除初始凭据或换成无意义的占位值，但其余必填变量仍须保留。

数据库连接必须二选一：直接运行 API 时可只设置 `DATABASE_URL`；Compose 使用 `DATABASE_HOST`、`DATABASE_PORT`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 这组分项变量。为避免迁移和运行时误连不同数据库，两种方式同时出现时 API 会拒绝启动。

登录限流默认只信任 API 连接的对端地址，并忽略客户端提供的 `X-Forwarded-For`。标准 Compose 不向宿主机暴露 API，由 Caddy 覆盖该请求头为实际客户端地址，并用独立的 `TRUST_PROXY_SECRET` 向 API 认证代理身份。请把示例值替换为至少 32 字节的随机秘密且不要复用其他密码。仅当 API 只能由持有该秘密且会覆盖（而非追加）该请求头的受信反向代理访问时才可开启 `TRUST_PROXY_HEADERS`；直接暴露 API 时必须保持关闭。

示例配置使用纯 HTTP 入口，因此 `COOKIE_SECURE=false` 只允许 `localhost` 或环回地址测试。正式部署应把 `PUBLIC_ORIGIN` 设为实际的 `https://` 来源并保持 `COOKIE_SECURE=true`，再由部署者用域名、上游反向代理或自己的 Caddy TLS 配置启用 HTTPS。不要在公网以明文 HTTP 提供管理后台。

常用运维命令：

```bash
docker compose -p movie-harbor ps
docker compose -p movie-harbor logs -f api caddy
docker compose -p movie-harbor restart
docker compose -p movie-harbor pull
docker compose -p movie-harbor up -d --build --wait
```

不要在保留数据时执行 `docker compose down --volumes`，该选项会删除命名卷。

## 半离线发布包

构建机与目标机首版都必须使用 `linux/arm64` Docker 平台，并安装 Docker Engine 与 Docker Compose v2。构建机还需要 Node.js、Git 和 tar，并能下载构建依赖。在仓库根目录执行：

```bash
./tools/build-offline-package.sh [版本]
# 或使用等价的 npm 入口：
npm run package:offline -- [版本]
```

`[版本]` 是可选参数，使用时替换为实际版本字符串并去掉方括号；省略时使用当前 Git 提交的 12 位短 SHA。产物固定写入 `dist/offline/movie-harbor-offline-linux-arm64-<版本>.tar.gz`，同名产物已存在时构建会拒绝覆盖。

包中只内置 API、公开站、管理后台这 3 个自研镜像。目标机仍必须能访问 Docker Hub 获取 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`，因此不支持完全断网部署。包内 Compose 使用固定版本的本地自研镜像且不包含源码构建上下文，启动时不会拉取或构建自研镜像。

将发布包复制到目标机后，解压到部署目录并执行：

```bash
tar -xzf movie-harbor-offline-linux-arm64-<版本>.tar.gz
cd movie-harbor
./load-images.sh
cp .env.example .env
# 编辑 .env：替换密码与代理秘密，配置 PUBLIC_ORIGIN、APP_PORT 和数据目录。
docker compose --env-file .env config
docker compose up -d --no-build --wait
```

`load-images.sh` 先用 `sha256sum` 校验包内文件，再导入镜像并验证 `linux/arm64` 平台；目标机需要提供该命令。校验用于检查文件完整性，分发时还应通过可信渠道核对外层归档的 SHA-256。公开站、管理后台及 HTTPS、初始管理员和代理秘密要求与上述生产部署说明一致。

`DATABASE_HOST_DIR` 映射到 PostgreSQL 的 `/var/lib/postgresql/data`，`MEDIA_HOST_DIR` 映射到 API 的 `/media` 和 Caddy 的只读 `/srv/media`。默认分别为解压目录下的 `./data/postgres` 和 `./data/media`；建议改为固定的宿主机绝对路径，以便升级时复用同一套数据。初始化容器会设置媒体目录的属主和权限。

升级前停止写入，并将数据库和媒体目录作为同一个一致性备份集保存；新包导入后，复用原有数据目录、部署项目名和经过核对的环境配置，再执行启动命令。包不包含真实 `.env`、密码、数据库、媒体数据、源码或开发依赖；备份与秘密须由部署者单独保管。停止本部署使用 `docker compose down`，不要删除仍需保留的数据目录。

## 上传格式与容量

- 海报：JPEG、PNG、WebP。后端同时检查扩展名、MIME 和实际图片内容。
- 视频：默认 MP4 (H.264) 和 WebM；浏览器必须能直接解码，服务端不会转码。
- `MAX_UPLOAD_BYTES` 是单文件上限，默认示例为 5 GiB。规划磁盘时需同时预留正式媒体、上传临时文件和替换期间新旧文件的空间。
- `/media` 是公开 URL，支持浏览器 Range 请求，但不提供防下载、DRM 或可靠防盗链。

## 一致备份与恢复

数据库元数据和 `media_data` 媒体卷必须作为同一个一致性备份集处理，只备份其中一项会产生丢失引用或孤立文件。稳妥的单机流程是在维护窗口停止写入，然后同时备份数据库逻辑导出和媒体卷：

```bash
docker compose -p movie-harbor stop api
docker compose -p movie-harbor exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > movie-harbor-db.dump
docker run --rm -v movie-harbor_media_data:/source:ro -v "$PWD":/backup alpine:3.22 tar -C /source -czf /backup/movie-harbor-media.tgz .
docker compose -p movie-harbor start api
```

恢复时先停止 API，将数据库恢复到空库并把媒体归档解压回 `movie-harbor_media_data`，确认两者来自同一备份点后再启动 API。备份文件包含私有内容与密码哈希，应加密保存并定期演练恢复。若修改了 Compose 项目名，卷名中的 `movie-harbor` 也会随之改变，请先用 `docker volume ls` 核对精确名称。

## 开发与验收

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
frontend/public-web/        公开 React 应用
frontend/admin-web/         管理后台 React 应用
frontend/packages/          共享 API 客户端与 UI
tests/e2e/                  Playwright 跨服务验收
demo/                       已审核的静态 UI Demo
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
