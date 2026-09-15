# Movie Harbor Windows 11 AMD64 半离线发布包设计

日期：2026-09-16

## 1. 背景与目标

当前半离线发布工具只允许 `linux/arm64` 构建机和目标机，不能生成适用于 Intel x86-64 电脑的运行镜像。本次扩展发布工具，使 macOS、Linux 或 CI 构建机能够生成 `linux/amd64` 半离线包，并在 Windows 11 64 位、Intel i7-8700K、Docker Desktop WSL2 后端的 Linux 容器模式中部署。

包内运行的仍是 Linux 容器，不支持原生 Windows Containers。本文档增量修订 `2026-09-12-offline-application-image-bundle-design.md`；涉及支持平台、产物命名和目标机脚本时，以本文档为准。

## 2. 支持矩阵

发布工具支持两个明确目标：

| 目标参数 | 容器平台 | 主要目标环境 |
| --- | --- | --- |
| `linux/arm64` | Linux ARM64 | 现有 ARM64 Linux 部署 |
| `linux/amd64` | Linux x86-64 | Windows 11 64 位 Intel/AMD + Docker Desktop |

Windows 目标环境必须启用 Docker Desktop 的 WSL2 后端和 Linux containers。Intel i7-8700K 满足 AMD64 指令架构要求。Windows on ARM、原生 Windows containers 和 32 位 Windows 不在支持范围内。

## 3. 构建接口与产物

构建入口扩展为：

```bash
./tools/build-offline-package.sh --platform linux/arm64 [版本]
./tools/build-offline-package.sh --platform linux/amd64 [版本]
```

为兼容现有调用，不传 `--platform` 时继续使用 `linux/arm64`。版本规则、输出目录、拒绝覆盖和失败清理行为保持不变。

产物名包含真实容器平台：

```text
dist/offline/movie-harbor-offline-linux-arm64-<版本>.tar.gz
dist/offline/movie-harbor-offline-linux-amd64-<版本>.tar.gz
```

AMD64 镜像标签对应为：

```text
movie-harbor-api:<版本>-linux-amd64
movie-harbor-public-web:<版本>-linux-amd64
movie-harbor-admin-web:<版本>-linux-amd64
```

工具使用 Docker Buildx/BuildKit 的目标平台能力构建并加载单平台镜像，之后通过镜像元数据验证 `linux/amd64`。归档仍只保存三个自研运行镜像，不生成多架构清单，也不导出构建阶段镜像或其他本机镜像。

Apple Silicon 构建 AMD64 时可以使用 Docker 提供的模拟能力，但速度和稳定性不作为正式发布保证。正式 AMD64 交付优先使用原生 AMD64 Linux 构建机或 CI runner。

## 4. Windows 包内容与 PowerShell 入口

AMD64 归档保留现有安全白名单，并增加经过校验的 Windows 脚本：

```text
movie-harbor/
├── images.tar
├── compose.yml
├── Caddyfile
├── .env.example
├── load-images.sh
├── load-images.ps1
├── start.sh
├── start.ps1
├── README.md
└── SHA256SUMS
```

`load-images.ps1` 必须：

1. 使用 PowerShell 原生 SHA-256 能力验证清单中的全部文件。
2. 校验失败时不导入任何镜像。
3. 执行 `docker image load`。
4. 验证三个精确标签存在且均为 `linux/amd64`。

`start.ps1` 必须：

1. 检查 Windows 64 位、Docker Desktop 可用、Compose v2 可用，并确认 Docker 正在运行 Linux 容器。
2. 读取 `.env` 中的 `MEDIA_HOST_DIR` 有序路径列表。
3. 使用 Windows 主机路径校验每个硬盘目录和卷身份，不把不存在的盘符静默创建成其他位置。
4. 生成 UTF-8、仅包含媒体挂载的 Compose 覆盖文件。
5. 使用基础 Compose、生成的覆盖文件和 `.env` 启动服务并等待健康检查。

Windows 路径使用 `D:/MovieHarbor/media` 形式。用户必须在 Docker Desktop 中允许对应目录或驱动器被 Linux VM 访问。生成的覆盖文件包含宿主机路径，属于本地部署状态，不进入归档回传或版本控制。

Linux 的 `start.sh` 提供相同的多卷解析和启动语义；两套入口生成等价的容器挂载与环境配置。

## 5. Compose 与运行边界

AMD64 包继续运行 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22` 的 Linux AMD64 变体。官方镜像仍由目标机在线从 Docker Hub 获取，半离线包不承诺完全断网。

API、公开站和管理后台只使用包内导入的 `linux/amd64` 自研镜像，并保持 `pull_policy: never`。启动时不得在 Windows 目标机从源码重新构建自研镜像。

PostgreSQL 和媒体数据继续使用宿主机 bind mount。`DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 必须指向 Docker Desktop 可访问的位置；部署脚本在启动前进行路径和写入探测。现有数据库与全部媒体卷仍需作为一致性备份集。

本次不改变 HTTP/HTTPS、安全 Cookie、代理秘密或管理员初始化规则。通过局域网 IP 或域名访问管理后台时，仍必须使用匹配的 HTTPS `PUBLIC_ORIGIN` 和 `COOKIE_SECURE=true`。

## 6. 升级与兼容

现有 ARM64 命令、标签和归档结构继续有效。AMD64 与 ARM64 产物可以使用相同版本号，因为文件名和镜像标签包含平台；工具仍拒绝覆盖同平台同版本产物。

Windows 升级流程必须先停止写入并一致备份数据库与全部媒体卷，然后导入新镜像，保留经过核对的 `.env` 和卷顺序，重新生成 Compose 覆盖文件并启动。发布包不包含或覆盖真实 `.env`、卷身份、数据库和媒体数据。

## 7. 错误处理与安全边界

- 不支持的平台值、Docker/Compose 不可用、Windows containers 模式、镜像架构不符或目标目录不可访问时立即失败。
- PowerShell 脚本不得执行下载的远程代码，不读取归档目录外的秘密文件，也不得在校验失败后继续。
- `.env` 中的路径在写入 Compose 覆盖文件前进行严格解析和安全引用，不能形成额外 YAML/JSON 字段或命令注入。
- 临时与生成文件使用确定目录和原子替换；失败时不得留下可被误认为完整部署配置的文件。
- 日志可以显示逻辑卷编号和操作建议，但不得输出密码、代理秘密或完整环境变量集合。

## 8. 测试与验收

实现遵循测试驱动开发，至少覆盖：

- CLI 默认 ARM64、显式 ARM64、显式 AMD64、非法平台和参数顺序。
- 两个平台的归档名、镜像标签、构建参数、镜像元数据检查和拒绝覆盖。
- AMD64 归档白名单、秘密排除、校验和及三个精确镜像标签。
- `load-images.ps1` 的校验失败优先、导入成功、缺失标签和错误架构行为。
- `start.ps1` 的 Docker 模式检查、Windows 路径解析、多卷覆盖文件、缺盘和卷身份不符行为。
- Linux 与 PowerShell 生成的 Compose 存储配置语义一致。
- 在原生 AMD64 构建环境中真实构建三个镜像并生成发布包。
- 在 Windows 11 64 位、Intel CPU、Docker Desktop WSL2/Linux containers 环境中导入并启动。
- 使用至少两个物理硬盘验证海报与视频按剩余可用空间选择、公开播放、跨卷替换和删除、容器重建及启动恢复。
- 运行现有 Rust、前端、Compose、离线包和端到端回归测试。

## 9. 非目标

- 原生 Windows Containers 或 Windows Server containers。
- Windows on ARM 和 32 位 Windows。
- 单个归档内包含 ARM64 与 AMD64 两套镜像。
- 多架构镜像清单、镜像仓库发布、镜像签名或 SBOM。
- 自动安装 Docker Desktop、WSL2、证书或宿主机防火墙规则。
- 把官方 PostgreSQL、Caddy 或 Alpine 镜像加入归档。
- 完全断网部署。
