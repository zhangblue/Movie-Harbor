# Movie Harbor Linux AMD64 半离线发布包设计

日期：2026-09-23

## 1. 背景与目标

当前半离线发布工具只生成 `linux/arm64` 自研镜像和归档，无法部署到使用 Intel 或 AMD x86-64 处理器的 Ubuntu 主机。本次扩展发布工具，在保持现有 ARM64 命令和产物兼容的前提下，增加可选的 `linux/amd64` 单平台构建。

本设计增量修订 `2026-09-12-offline-application-image-bundle-design.md` 的平台限制。涉及支持平台、命令参数、镜像标签、产物命名和目标平台校验时，以本文档为准。

## 2. 支持平台与兼容性

发布工具支持以下两个目标平台：

| 平台参数 | 容器架构 | 主要目标环境 |
| --- | --- | --- |
| `linux/arm64` | Linux ARM64 | 现有 ARM64 Linux 部署 |
| `linux/amd64` | Linux x86-64 | Intel 或 AMD 64 位 Ubuntu 部署 |

不传平台参数时继续使用 `linux/arm64`，确保现有自动化和人工命令保持原有行为。每个发布包只包含一个目标平台的三个自研运行镜像，不生成多架构清单，也不在同一归档中混装两套镜像。

## 3. 命令接口

构建入口支持以下形式：

```bash
./tools/build-offline-package.sh [版本]
./tools/build-offline-package.sh --platform linux/arm64 [版本]
./tools/build-offline-package.sh --platform linux/amd64 [版本]
```

`npm run package:offline --` 透传相同参数。版本仍可省略；省略时使用当前 Git 提交的 12 位短 SHA。

CLI 只接受上述两种平台值。未知选项、缺少平台值、多余位置参数和不支持的平台必须在执行 Docker 命令前失败，并显示包含平台参数的用法说明。

## 4. 构建与产物

三个自研镜像使用 Docker Buildx/BuildKit 进行单平台构建，并通过 `--load` 导入本地 Docker 镜像库，以供后续检查和 `docker image save`。工具将所选平台传给每个镜像构建，并在导出前检查镜像元数据中的操作系统和架构。

产物名包含所选平台：

```text
dist/offline/movie-harbor-offline-linux-arm64-<版本>.tar.gz
dist/offline/movie-harbor-offline-linux-amd64-<版本>.tar.gz
```

镜像标签同样包含平台：

```text
movie-harbor-api:<版本>-linux-arm64
movie-harbor-public-web:<版本>-linux-arm64
movie-harbor-admin-web:<版本>-linux-arm64

movie-harbor-api:<版本>-linux-amd64
movie-harbor-public-web:<版本>-linux-amd64
movie-harbor-admin-web:<版本>-linux-amd64
```

不同平台可以使用相同版本号；工具只拒绝覆盖同平台、同版本的已有归档。

## 5. 构建机与目标机边界

原生 AMD64 Linux 构建机是生成 Ubuntu Intel 交付包的首选环境。Docker Desktop 或配置了相应模拟能力的 BuildKit 也可以尝试跨架构构建，但模拟构建的性能和稳定性不作为正式保证。

发布工具不再要求 Docker 守护进程的平台与目标平台相同。它只要求 Docker、Buildx 和 Compose v2 可用，并以最终镜像元数据为权威校验结果。如果构建环境不能执行目标平台的构建阶段，构建必须失败且不发布归档。

目标机必须运行 64 位 Linux、Docker Engine 和 Docker Compose v2。Intel Ubuntu 目标机使用 `linux/amd64` 包；ARM64 Linux 目标机继续使用 `linux/arm64` 包。加载脚本必须在导入后验证三个精确镜像标签均与包声明的平台一致。

## 6. 归档内容与部署边界

归档白名单保持不变：

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

包内仍只包含 API、公开站和管理后台三个自研镜像。`postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22` 继续由目标机从 Docker Hub 获取与目标平台匹配的官方镜像。

Compose 中的自研服务使用所选平台对应的精确标签并保留 `pull_policy: never`。归档不包含源码、真实 `.env`、凭据、数据库、媒体数据或官方运行镜像。

## 7. 错误处理与安全边界

- 参数错误、Docker/Buildx/Compose 不可用、构建失败、镜像平台不符、导出标签集合不符或归档白名单不符时立即失败。
- 失败时不得留下最终归档或本次创建的临时目录。
- 版本和平台只通过严格白名单进入文件名、镜像标签和模板，不能形成路径穿越或命令注入。
- `load-images.sh` 必须先验证 `SHA256SUMS`，校验失败时不得导入镜像。
- 日志不得输出 `.env` 内容、密码、代理秘密或其他凭据。

## 8. 测试与验收

实现遵循测试驱动开发，至少覆盖：

- 不传平台时默认 ARM64，显式 ARM64 与显式 AMD64 均被接受。
- 未知选项、缺少平台值、多余位置参数和不支持平台在 Docker 调用前失败。
- 两个平台分别生成正确的归档名、三个镜像标签、Buildx 平台参数、Compose 镜像引用和加载脚本校验。
- 构建机架构不再决定目标平台；最终镜像架构与所选平台不一致时失败。
- ARM64 现有归档白名单、校验和、秘密排除、拒绝覆盖和失败清理行为不回归。
- AMD64 包在原生 AMD64 环境中能够构建、导入，并在 Intel Ubuntu Docker 环境中通过 Compose 启动和健康检查。
- 运行现有离线包、Compose、前端构建、Rust 和端到端测试的相关子集。

## 9. 非目标

- Windows PowerShell 部署脚本或原生 Windows Containers。
- 一个归档同时包含 ARM64 与 AMD64 镜像。
- 多架构镜像清单或镜像仓库发布。
- 自动安装 Docker、Buildx、Compose、QEMU 或宿主机系统依赖。
- 将 PostgreSQL、Caddy 或 Alpine 官方镜像打入归档。
- 完全断网部署、镜像签名、SBOM 或发布包自动上传。
