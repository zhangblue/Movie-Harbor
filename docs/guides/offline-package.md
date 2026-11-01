# 半离线发布指南

本文说明单平台半离线包的构建、校验、目标机部署与升级。

[返回项目 README](../../README.md)

## 半离线发布包

ARM64 后端在构建机宿主系统中执行 `cargo zigbuild --locked --release --target aarch64-unknown-linux-musl --target-dir <本次临时目录> -p movie-harbor-api`，再由 Docker 组装 Debian 运行镜像。构建机可以是 macOS Apple Silicon 或 Linux，但生成、打包和部署的程序仅支持 Linux ARM64；它不是 macOS 程序，也不能直接在 macOS 中运行。

AMD64 后端仍在现有 Linux 构建容器中使用固定的 `x86_64-unknown-linux-musl` Zig 工具链，宿主机不需要为 AMD64 单独安装 Zig。

ARM64 构建直接使用本机已安装的 Rust、cargo-zigbuild 和 Zig，沿用当前 `PATH` 和 rustup 环境，不要求精确版本。如果本机安装了多个 Zig，先把需要的稳定版 Zig 目录放在 `PATH` 最前，再运行发布工具：

```bash
export PATH="/path/to/stable-zig:$PATH"
```

发布工具会解析 `PATH` 中的第一个 `zig`，用它输出版本，并为本次编译设置 `CARGO_ZIGBUILD_ZIG_COMMAND`，因此不会被 Python `ziglang` 或外部遗留的 cargo-zigbuild Zig 覆盖变量切换到另一个版本。随后检查版本与 Rust target：

```bash
rustc --version
cargo-zigbuild --version
zig version
rustup target list --installed          # 必须包含 aarch64-unknown-linux-musl
```

前三条命令必须执行成功并输出非空版本文本。发布工具不比较 Zig 的具体版本号，也不拒绝开发版版本字符串；实际编译会验证选定 Zig 与当前代码的兼容性。构建会打印本次实际使用的三个工具版本。

如未安装 ARM64 musl target，由使用者主动安装：

```bash
rustup target add aarch64-unknown-linux-musl
```

工具或 target 缺失时，发布工具会在 Docker API 镜像构建前失败，不自动安装、升级或切换宿主机工具链。构建机还需要 Docker Engine、Docker Buildx、Docker Compose v2、Node.js、Git 和 tar，以及用于 ARM64 程序架构与静态链接校验的 `file` 命令，并能下载构建依赖。AMD64 继续使用固定版本的容器工具链。工具按指定平台构建并校验最终镜像元数据，Docker 守护进程的架构无需与目标平台相同。在仓库根目录执行：

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
