# Windows 11 AMD64 半离线包验证记录

日期：2026-09-16

## 状态与签署边界

正式构建状态：**BLOCKED — 尚无原生 AMD64 Linux 构建机或 CI 的成功构建、归档 SHA-256、allowlist 与三个镜像平台检查证据。**

Windows 实机状态：**PENDING — 尚未在 Windows 11 64 位、Intel i7-8700K、Docker Desktop WSL2/Linux containers 和双物理硬盘环境执行。**

本机补充状态：**PARTIAL — 契约测试已执行；Apple Silicon 模拟构建曾在 Docker Hub OAuth token 请求超时时失败，未生成归档。**

在上述两项外部证据都完成前，不得把本记录改写为“Windows 11 已验证”，也不得用 macOS、AArch64、Docker 模拟、脚本静态检查或被跳过的 PowerShell 测试代替实机结果。所有待填写字段保留为“待执行”或“待填写”，不得预填成功。

证据不得包含密码、`TRUST_PROXY_SECRET`、用户名、私有绝对路径或完整 `.env`。日志中的目录用“卷 0 / 卷 1”等脱敏名称标识；原始证据文件放在受控验收存储中，本仓库只记录摘要和校验值。

## 已取得的本机补充证据

### 环境

| 项目 | 实际值 |
| --- | --- |
| 构建宿主架构 | `arm64` |
| Docker 守护进程 | `linux/aarch64` |
| Docker 客户端 / 服务端 | `29.4.0` / `29.4.0` |
| Docker Buildx | `v0.33.0` |
| Docker Compose | `5.1.2` |
| 尝试的目标平台 | `linux/amd64` |
| 尝试的版本 | `windows11-i7-validation` |

Task 5 运行 `npm run test:package` 时记录为 60 项通过、22 项 Windows PowerShell 行为测试因非 Windows 宿主明确跳过；这只能证明可在当前宿主执行的契约。运行 `./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation` 时，首个 API 镜像读取 `rust:1.91-bookworm` 元数据并获取 Docker Hub OAuth token 超时，退出前未执行镜像平台检查、`docker image save` 或归档发布。

失败后的检查结果：目标归档不存在，三个预期标签不存在，工具拥有的 `movie-harbor-offline-*` 临时目录无残留。因为没有归档，本记录没有填写伪造的归档 SHA-256、allowlist 或 `images.tar` 平台结果。

## 原生 AMD64 Linux / CI 正式构建记录

本节只能在 `uname -m` 为 `x86_64` 且 Docker 守护进程报告 `linux/amd64` 的构建环境填写。

### 环境证据

| 字段 | 预期 | 实际值 / 证据文件 |
| --- | --- | --- |
| 构建日期与操作者 | 可追溯 | 待填写 |
| `uname -m` | `x86_64` | 待填写 |
| Docker 守护进程 | `linux/amd64` | 待填写 |
| Docker 客户端 / 服务端 | 版本号 | 待填写 |
| Buildx | 可用、版本号 | 待填写 |
| Compose | v2、版本号 | 待填写 |
| Git 提交 | 本次验收提交 | 待填写 |
| 外层证据文件 | 脱敏日志 | 待填写 |

执行并保存完整退出码和脱敏输出：

```bash
uname -m
docker info --format '{{.OSType}}/{{.Architecture}}'
docker version
docker buildx version
docker compose version
./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation
sha256sum dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz
tar -tzf dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz
```

### 归档与镜像证据

| 验收项 | 预期 | 实际结果 | 证据文件 / 摘要 |
| --- | --- | --- | --- |
| 构建退出码 | `0` | 待执行 | 待填写 |
| 归档 allowlist | 仅 `movie-harbor/`、镜像包、Compose、Caddy、示例配置、双平台相应脚本、README、校验清单 | 待执行 | 待填写 |
| 秘密与数据排除 | 无真实 `.env`、凭据、数据库、媒体、源码 | 待执行 | 待填写 |
| 外层归档 SHA-256 | 64 位十六进制 | 待生成 | 待填写 |
| `movie-harbor-api:windows11-i7-validation-linux-amd64` | `linux/amd64` | 待执行 | 待填写 |
| `movie-harbor-public-web:windows11-i7-validation-linux-amd64` | `linux/amd64` | 待执行 | 待填写 |
| `movie-harbor-admin-web:windows11-i7-validation-linux-amd64` | `linux/amd64` | 待执行 | 待填写 |

正式结论：**BLOCKED**。只有以上字段都有可复核证据后才可签署原生 AMD64 构建。

## Windows 11 Intel 实机验收记录

### 1. 环境确认

| 字段 | 预期 | 实际值 | 证据文件 / 截图 |
| --- | --- | --- | --- |
| Windows 版本 | Windows 11 64 位，记录版本与 OS build | 待填写 | 待填写 |
| CPU | Intel i7-8700K | 待填写 | 待填写 |
| 系统架构 | 64 位 x86-64 | 待填写 | 待填写 |
| Docker Desktop | 记录版本 | 待填写 | 待填写 |
| Docker 后端 | WSL2 | 待填写 | 待填写 |
| Docker 模式 | Linux containers | 待填写 | 待填写 |
| Docker 守护进程 | `linux/amd64` | 待填写 | 待填写 |
| Docker Compose | v2，记录版本 | 待填写 | 待填写 |
| 卷 0 | 第一块真实物理硬盘上的现存目录 | 待填写（脱敏） | 待填写 |
| 卷 1 | 第二块真实物理硬盘上的现存空目录 | 待填写（脱敏） | 待填写 |

在 PowerShell 中收集环境证据：

```powershell
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
Get-CimInstance Win32_Processor | Select-Object Name, AddressWidth
docker version
docker info --format '{{.OSType}}/{{.Architecture}}'
docker compose version
```

确认 Docker Desktop 设置页面显示 WSL2 backend，且两个驱动器均可由 Linux VM 访问。不要记录本机用户名或完整私有目录。

### 2. 解压、校验、导入和启动

先从正式构建记录取得归档及可信外层 SHA-256，再在新的部署目录执行：

```powershell
$Archive = 'movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz'
Get-FileHash -LiteralPath $Archive -Algorithm SHA256
tar -xzf $Archive
Set-Location movie-harbor
.\load-images.ps1
Copy-Item .env.example .env
```

编辑 `.env` 时只在本机填写真实秘密。路径必须是现存的正斜杠绝对盘符路径，例如：

```dotenv
DATABASE_HOST_DIR=D:/MovieHarbor/postgres
MEDIA_HOST_DIR=D:/MovieHarbor/media;E:/MovieHarbor/media
```

随后执行：

```powershell
.\start.ps1
docker compose --env-file .env -f compose.yml -f compose.storage.generated.json ps
docker image inspect --format '{{.Os}}/{{.Architecture}}' movie-harbor-api:windows11-i7-validation-linux-amd64
docker image inspect --format '{{.Os}}/{{.Architecture}}' movie-harbor-public-web:windows11-i7-validation-linux-amd64
docker image inspect --format '{{.Os}}/{{.Architecture}}' movie-harbor-admin-web:windows11-i7-validation-linux-amd64
```

| 验收项 | 预期 | 实际结果 | 退出码 / 证据文件 |
| --- | --- | --- | --- |
| 外层 SHA-256 | 与正式构建记录一致 | 待执行 | 待填写 |
| `load-images.ps1` | 校验后导入，退出码 `0` | 待执行 | 待填写 |
| 三个镜像平台 | 全部 `linux/amd64` | 待执行 | 待填写 |
| `start.ps1` | 退出码 `0` | 待执行 | 待填写 |
| Compose 状态 | 服务全部健康 | 待执行 | 待填写 |
| 卷登记 | 卷 0、卷 1 顺序与 `.env` 一致 | 待执行 | 待填写 |
| 登录 | `/admin/` 可成功登录 | 待执行 | 待填写 |

### 3. 双物理硬盘业务流程

每次上传前记录卷 0 和卷 1 的真实可用字节，并预先写出“应选择的卷”；上传后以公开 URL 的 `/media/v<编号>/...` 与对应物理盘文件共同证明实际选择。不要仅凭界面成功消息判断落盘位置。

在每次上传前立即记录两盘可用字节；把实际盘符映射成卷 0 / 卷 1 后再保存脱敏输出：

```powershell
Get-PSDrive -Name D,E -PSProvider FileSystem | Select-Object Name,Used,Free
```

| 场景 | 上传前卷 0 / 卷 1 可用字节 | 预期选择 | 实际 URL / 物理卷 | 结果 | 证据文件 |
| --- | --- | --- | --- | --- | --- |
| 海报上传 | 待填写 | 待填写 | 待执行 | 待执行 | 待填写 |
| 电影视频上传 | 待填写 | 待填写 | 待执行 | 待执行 | 待填写 |
| 单集视频上传 | 待填写 | 待填写 | 待执行 | 待执行 | 待填写 |
| 跨卷替换 | 待填写 | 新文件在更空闲卷，旧文件删除 | 待执行 | 待执行 | 待填写 |
| 电影删除 | 不适用 | 数据库与对应卷文件同步删除 | 待执行 | 待执行 | 待填写 |
| 剧集 / 单集删除 | 不适用 | 跨卷文件同步删除 | 待执行 | 待执行 | 待填写 |
| 公开播放与 Range | 不适用 | 海报可读、视频可播放与拖动 | 待执行 | 待执行 | 待填写 |

普通容器重建：先确认业务数据已经一致备份，再在同一部署目录执行以下命令，确保 `.env` 和卷顺序不变。该流程只验证停止后重新创建容器，不制造或验证媒体持久清单的中断状态：

```powershell
docker compose --env-file .env -f compose.yml -f compose.storage.generated.json down
.\start.ps1
docker compose --env-file .env -f compose.yml -f compose.storage.generated.json ps
```

| 验收项 | 预期 | 实际结果 | 证据文件 |
| --- | --- | --- | --- |
| 容器重建 | 复用原数据库和两卷，不重建或改号 | 待执行 | 待填写 |
| 重启后播放 | 原公开 URL 继续可用 | 待执行 | 待填写 |

持久清单中断恢复：**PENDING — 当前没有经过安全设计的 Windows 实机故障注入步骤与可复核证据。** 普通 `down → start.ps1` 不会产生中断清单，不能用于签署“按数据库引用恢复或清理”。只有另行设计不会破坏唯一验收数据、能够确定性中断在清单持久化之后的隔离场景并取得证据，才可填写下表：

| 验收项 | 预期 | 当前状态 | 证据文件 |
| --- | --- | --- | --- |
| 持久清单中断恢复 | 数据库仍引用则恢复原文件，不再引用则完成清理 | **PENDING** | 待设计并执行 |

### 4. 隔离失败路径

每项都使用归档副本、独立部署目录、独立测试数据库目录和独立空媒体目录；不得修改唯一归档或第 3 节的验收数据。记录命令、退出码、标准错误和“失败前未发生的副作用”。

| 失败路径 | 操作 | 预期 | 实际结果 | 命令 / 证据文件 |
| --- | --- | --- | --- | --- |
| 校验文件篡改 | 修改副本中的一个受校验文件后运行 `load-images.ps1` | 在 `docker image load` 前失败 | 待执行 | 待填写 |
| 错误镜像架构 | 使用受控的错误架构测试包运行加载入口 | 平台检查失败，不签署导入成功 | 待执行 | 待填写 |
| 错误卷标记 | 在隔离部署中把一个 marker 改成错误卷号后运行 `start.ps1` | Compose 启动前失败，错误 marker 不被覆盖 | 待执行 | 待填写 |
| 缺失盘符 / 目录 | 在隔离 `.env` 中引用不存在的盘符或目录 | 启动前失败，不在其他盘创建替代目录 | 待执行 | 待填写 |
| 无效数据库目录 | 在尚无媒体登记的隔离部署中，把首个 `DATABASE_HOST_DIR` 改为相对、UNC、通配符、缺失或不可写目录 | 在任何媒体 state、marker 或覆盖文件写入前失败 | 待执行 | 待填写 |

失败恢复时保留日志，恢复可信归档或正确卷身份，再从同一入口重试。不得删除正式部署的卷登记或身份标记来绕过校验。

### 5. Windows 签署

| 字段 | 值 |
| --- | --- |
| Windows 实机状态 | **PENDING** |
| 验收人 | 待填写 |
| 验收日期 | 待填写 |
| 对应归档 SHA-256 | 待填写 |
| 原生 AMD64 构建证据文件 | 待填写 |
| Windows 命令日志 | 待填写 |
| 双卷业务证据文件 | 待填写 |
| 失败路径证据文件 | 待填写 |
| 最终结论 | 待执行，当前不得签署 |
