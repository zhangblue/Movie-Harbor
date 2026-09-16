# Windows 11 AMD64 半离线包验证记录

日期：2026-09-16

## 状态摘要

当前状态：**部分完成，正式发布证据仍受阻**。

- 已完成：发布工具契约测试，以及 Apple Silicon / AArch64 Docker 守护进程上的一次真实 Buildx 模拟构建尝试。
- 未完成：原生 AMD64 Linux 构建机或 CI 上的正式包构建、归档检查和 SHA-256 记录。
- 未完成：Windows 11 Intel 实机导入、启动和双物理硬盘验收。

本文档严格区分补充证据与正式验收；本机模拟结果不能代替原生 AMD64 或 Windows 11 实机结果。

## 本机模拟 / 补充证据

### 环境

| 项目 | 实际值 |
| --- | --- |
| 构建宿主架构 | `arm64` |
| Docker 守护进程 | `linux/aarch64` |
| Docker 客户端 / 服务端 | `29.4.0` / `29.4.0` |
| Docker Buildx | `v0.33.0` |
| Docker Compose | `5.1.2` |
| 目标平台 | `linux/amd64` |
| 目标版本 | `windows11-i7-validation` |

### 契约测试

运行：

```bash
npm run test:package
node --check tools/offline-package.mjs
```

结果：`npm run test:package` 共 80 项，其中 58 项通过、22 项 Windows PowerShell 行为测试因当前非 Windows 宿主而明确跳过；Node 语法检查通过。契约覆盖 Buildx 前置检查、任一镜像构建失败时不执行 `docker image save`，以及三个目标镜像全部通过平台检查后才导出归档。

### Buildx 模拟构建尝试

运行：

```bash
./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation
```

结果：**失败，未生成发布包**。首次 API 镜像构建在读取 `rust:1.91-bookworm` 元数据时，因获取 Docker Hub OAuth token 超时而中止。失败发生在任何目标镜像加载、镜像平台检查或 `docker image save` 之前。

失败清理检查：

- `dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz` 不存在。
- 三个预期镜像标签均不存在。
- 工具拥有的 `movie-harbor-offline-*` 临时目录未残留。
- 因没有归档，allowlist、归档 SHA-256、`images.tar` 标签及平台检查均没有可记录的实际结果。

预期但本次未生成的镜像标签：

```text
movie-harbor-api:windows11-i7-validation-linux-amd64
movie-harbor-public-web:windows11-i7-validation-linux-amd64
movie-harbor-admin-web:windows11-i7-validation-linux-amd64
```

## 原生 AMD64 Linux 或 CI 正式证据待办

必须在原生 AMD64 Linux 构建机或 AMD64 CI runner 上重新执行，Apple Silicon 模拟结果不得勾选本节：

- [ ] 记录 `uname -m` 为 `x86_64`，Docker 守护进程为 `linux/amd64`。
- [ ] 记录 Docker、Buildx 和 Compose 版本。
- [ ] 运行 `./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation` 并确认零错误。
- [ ] 确认归档精确匹配发布 allowlist，且不包含源码、真实 `.env`、凭据、数据库或媒体数据。
- [ ] 记录归档 SHA-256：`待生成`。
- [ ] 独立导入 `images.tar`，确认上述三个精确标签全部存在。
- [ ] 对每个标签独立检查，结果均精确为 `linux/amd64`。
- [ ] 保存不含用户名、私有绝对路径或秘密的 CI 日志或验收记录。

正式状态：**BLOCKED — 当前没有原生 AMD64 Linux / CI 构建证据，且本机模拟构建受 Docker Hub 网络超时阻断。**

## Windows 11 实机待办

以下项目属于任务 6，本次未执行，也不得从本机测试推断其结果：

- [ ] Windows 11 64 位、Intel i7-8700K。
- [ ] Docker Desktop 使用 WSL2 后端并处于 Linux containers 模式。
- [ ] PowerShell 校验归档 SHA-256 后导入三个镜像。
- [ ] 三个镜像均验证为 `linux/amd64`。
- [ ] 使用两个真实物理硬盘目录完成首次注册与重启恢复。
- [ ] 验证海报和视频选择剩余可用空间最多的硬盘。
- [ ] 验证公开播放、跨卷替换和删除、容器重建及中断恢复。

实机状态：**PENDING — 未在 Windows 11 电脑上执行。**
