# 半离线发布指南

本文说明单平台半离线包的构建、校验、目标机部署与升级。

[返回项目 README](../../README.md)

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
# 编辑 .env：替换密码与代理秘密并核对数据目录；默认仅本机管理。可信局域网 HTTP 须显式开启 ALLOW_INSECURE_LAN_HTTP；正式部署须按部署指南配置 HTTPS。
docker compose --env-file .env config
docker compose up -d --no-build --wait
```

`load-images.sh` 先用 `sha256sum` 校验包内文件，再导入镜像并验证三个精确标签与包声明的平台一致；目标机需要提供该命令。校验用于检查文件完整性，分发时还应通过可信渠道核对外层归档的 SHA-256。包内的默认本机、显式可信局域网 HTTP 和正式 HTTPS 配置，以及初始管理员和代理秘密要求，均与[部署指南](deployment.md)一致。

`DATABASE_HOST_DIR` 映射到 PostgreSQL 的 `/var/lib/postgresql/data`，`MEDIA_HOST_DIR` 映射到 API 的 `/media` 和 Caddy 的只读 `/srv/media`。默认分别为解压目录下的 `./data/postgres` 和 `./data/media`；建议改为固定的宿主机绝对路径，以便升级时复用同一套数据。初始化容器会设置媒体目录的属主和权限。

升级前停止写入，并将数据库和媒体目录作为同一个一致性备份集保存；新包导入后，复用原有数据目录、部署项目名和经过核对的环境配置，再执行启动命令。包不包含真实 `.env`、密码、数据库、媒体数据、源码或开发依赖；备份与秘密须由部署者单独保管。停止本部署使用 `docker compose down`，不要删除仍需保留的数据目录。

升级前检查[媒体与备份指南](media-and-backup.md)中的迁移要求，并按其中的一致备份与恢复流程保护数据。
