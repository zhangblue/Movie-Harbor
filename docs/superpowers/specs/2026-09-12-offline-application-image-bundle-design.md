# Movie Harbor 半离线 Docker 发布包设计

## 目标

提供一个仓库内发布工具，把当前代码构建成可转交给其他服务器的 Docker 部署包。发布包不包含源码，只携带 Movie Harbor 自研运行镜像和启动所需的少量配置文件。接收服务器导入自研镜像、修改环境配置后，可用 Docker Compose 启动服务。

首版只支持当前 Docker 引擎平台。当前平台为 `linux/arm64`（Docker 报告为 `linux/aarch64`）；不在首版实现 `linux/amd64`、多架构清单或跨平台构建。

## 发布模式

发布包采用“自研镜像离线、官方镜像在线”的半离线模式：

- 离线归档只包含 API、公开站和管理后台 3 个自研运行镜像。
- PostgreSQL、入口 Caddy 和媒体初始化 Alpine 镜像不进入归档，由接收服务器按 Compose 中固定版本从 Docker Hub 下载。
- 因此目标服务器必须能够访问 Docker Hub；本包不承诺完全断网部署。
- 自研服务在交付用 Compose 中设置 `pull_policy: never`，防止 Compose 尝试从镜像仓库拉取不存在的项目镜像。
- 官方服务保留默认的 `missing` 拉取策略；本地没有对应镜像时，`docker compose up` 自动下载。

与包含全部依赖镜像的完全离线包相比，该方案显著缩小归档体积，同时保留项目代码和私有镜像无需上传公共仓库的部署方式。

## 工具接口

仓库新增可执行工具：

```bash
./tools/build-offline-package.sh [版本]
```

- 版本可选；未提供时使用当前 Git 短提交号。
- 版本只允许字母、数字、点、下划线和连字符，禁止路径分隔符及空白。
- 工具必须从仓库根目录定位输入，不依赖调用者当前目录。
- 输出固定写入被 Git 忽略的 `dist/offline/`。
- 产物名为 `movie-harbor-offline-linux-arm64-<版本>.tar.gz`。
- 已存在同名产物时拒绝覆盖，避免误替换已交付版本。

工具依次执行环境检查、构建、标记、平台检查、生成交付目录、导出镜像、完整性检查和原子发布。任何步骤失败都返回非零状态并清理临时目录，不留下看似成功的半成品。

## 镜像构建与命名

工具复用现有 3 个多阶段 Dockerfile 构建运行镜像，不修改生产镜像内容：

- `movie-harbor-api:<版本>-linux-arm64`
- `movie-harbor-public-web:<版本>-linux-arm64`
- `movie-harbor-admin-web:<版本>-linux-arm64`

构建后通过 `docker image inspect` 验证每个镜像都是 `linux/arm64`。只有这 3 个精确标签传给 `docker image save`；不得通过 Compose 的全部镜像列表导出 PostgreSQL、Caddy、Alpine、构建阶段镜像或其他本机镜像。

运行镜像由现有多阶段 Dockerfile 产生：API 镜像只包含运行依赖和 Rust 二进制，两个 Web 镜像只包含 Caddy 运行层与 Vite 构建产物，不包含仓库源码、`.git`、测试或构建工具链。

## 发布包结构

解压后的目录结构固定为：

```text
movie-harbor/
├── images.tar
├── compose.yml
├── Caddyfile
├── .env.example
├── load-images.sh
├── README.md
└── SHA256SUMS
```

- `images.tar`：仅包含 3 个自研镜像的层、元数据和精确标签。
- `compose.yml`：独立交付模板，只含 `image:`，不得包含 `build:`、源码路径或开发卷；数据目录仍通过 `DATABASE_HOST_DIR` 和 `MEDIA_HOST_DIR` 映射到宿主机。
- `Caddyfile`：运行所需的入口路由配置。
- `.env.example`：从项目示例派生的配置模板，不复制开发者本地 `.env`，不携带密码或其他秘密。
- `load-images.sh`：先验证 `SHA256SUMS`，再执行 `docker image load -i images.tar`，最后检查 3 个精确标签均已存在且平台匹配。
- `README.md`：说明联网要求、配置、导入、启动、停止、升级和数据目录注意事项。
- `SHA256SUMS`：覆盖镜像归档和除校验清单自身之外的全部部署文件，便于传输后检查损坏。

外层 `tar.gz` 只包含上述 `movie-harbor/` 目录。工具在发布前列举归档内容并拒绝任何未允许条目；特别拒绝 `.git`、Dockerfile、`src/`、`tests/`、`node_modules/`、`target/`、本地 `.env` 和宿主数据目录。

## 目标服务器流程

接收服务器需要 Docker Engine 和 Docker Compose v2，并能访问 Docker Hub：

```bash
tar -xzf movie-harbor-offline-linux-arm64-<版本>.tar.gz
cd movie-harbor
./load-images.sh
cp .env.example .env
# 编辑 .env
docker compose up -d --no-build --wait
```

Compose 对自研镜像使用 `pull_policy: never`，对缺失的官方镜像按默认策略从 Docker Hub 下载。部署文档明确提示：`linux/amd64` 服务器不能使用首版 `linux/arm64` 包。

## 配置与数据

交付 Compose 保持现有运行拓扑、健康检查、服务依赖和安全边界。数据库与媒体仍是宿主机 bind mount，默认相对于交付目录使用 `./data/postgres` 和 `./data/media`，也允许在 `.env` 中设置绝对路径。

首次启动规则、管理员初始化、`PUBLIC_ORIGIN`、`COOKIE_SECURE`、代理秘密、上传上限和媒体格式继续沿用项目 README。工具绝不读取或复制仓库根目录的 `.env`，也不打包任何数据库或媒体数据。

## 错误处理与安全边界

- Docker 不可用、Compose v2 不可用、平台不是当前支持值、版本非法、构建失败、镜像缺失或平台不符时立即失败。
- 临时目录使用系统安全临时目录创建，并由退出处理器清理。
- 最终归档先写临时文件，通过内容、校验和及镜像标签检查后再原子移动到目标名称。
- 不删除或覆盖已有归档，不修改开发者现有镜像以外的数据，不读取本地秘密。
- `load-images.sh` 在校验失败时不得导入；平台或标签校验失败时明确报错。
- 官方镜像使用固定版本标签，但由目标服务器在线获取；Docker Hub 不可访问时启动应失败并提示缺失的官方镜像，而不是回退构建源码。

## 测试与验收

实现遵循 TDD，并至少覆盖：

1. 版本、平台和输出路径校验。
2. 交付 Compose 只含 `image:`，3 个自研服务为 `pull_policy: never`，官方服务未被禁止拉取。
3. 使用可控 Docker 替身验证 `image save` 只收到 3 个自研标签。
4. 归档白名单与秘密排除，确保无源码、本地 `.env` 或数据目录。
5. 校验和生成与 `load-images.sh` 的失败优先行为。
6. 用真实 Docker 为当前 `linux/arm64` 构建 3 个镜像，生成真实发布包。
7. 在空的隔离 Compose 项目中导入归档并验证 `docker compose config`；在官方镜像可在线获取的环境中启动、健康检查、停止并清理隔离数据。
8. 运行现有 Rust、前端和 Compose 回归测试，确保发布工具不改变应用行为。

## 非目标

- 完全断网部署。
- 把 PostgreSQL、Caddy 或 Alpine 打入离线镜像归档。
- `linux/amd64`、多架构或远程构建。
- 镜像签名、SBOM、远程镜像仓库发布或自动上传发布包。
- 打包生产数据库、媒体文件、本地 `.env` 或任何凭据。
