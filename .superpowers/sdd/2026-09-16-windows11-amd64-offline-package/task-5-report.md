# Task 5 报告：真实 AMD64 包构建与归档检查

## 状态

**PARTIAL / BLOCKED，不得标记为 complete。**

本机可执行的契约测试、模拟构建尝试和失败清理检查已经完成；原生 AMD64 Linux / CI 正式构建证据仍缺失，Windows 11 实机验收属于 Task 6，未在本任务执行。

## 变更

- `package.json` 增加 `test:package` 聚焦入口。
- `tests/offline-package.test.mjs` 锁定以下行为：
  - AMD64 构建在 Buildx 不可用时不会开始。
  - API、公开站或管理后台任一镜像构建失败时，不检查镜像、不调用 `docker image save`，也不留下半成品。
  - 三个 AMD64 镜像均完成平台检查后才导出归档。
- `docs/verification/windows11-amd64-package.md` 分开记录本机补充证据、原生 AMD64 正式证据待办和 Windows 11 实机待办。

## TDD 记录

### 第一轮：聚焦测试入口

RED：首次运行 `npm run test:package`，因 `package.json` 尚无该脚本而失败：

```text
npm error Missing script: "test:package"
```

GREEN：增加脚本后，离线包与 PowerShell 契约测试可通过统一入口执行。

### 审查修复：三个构建失败位置

先将测试参数化为 API、公开站和管理后台三个失败位置，但不扩展 Docker 测试替身。运行：

```bash
node --test --test-name-pattern='image build fails' tests/offline-package.test.mjs
```

RED：3 项全部按预期失败；测试替身未识别新模式，构建继续至平台检查并得到 `linux/arm64`，证明新增场景不是预先通过。

随后只扩展测试替身，使对应 Dockerfile 在指定位置返回 `Build failed`。

GREEN：同一命令 3/3 通过；每个场景分别确认只进行了 1、2、3 次构建，且均未调用镜像检查或镜像导出。

## 本机构建尝试

实际环境：

```text
host: arm64
Docker daemon: linux/aarch64
Docker client/server: 29.4.0/29.4.0
Buildx: 0.33.0
Compose: 5.1.2
target: linux/amd64
```

实际运行：

```bash
./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation
```

结果：在首个 API 镜像读取 `rust:1.91-bookworm` 元数据时，因获取 Docker Hub OAuth token 网络超时而失败。构建未到达镜像平台检查、`docker image save` 或归档发布阶段。

## 失败清理证据

- 目标归档不存在。
- API、公开站和管理后台三个预期 AMD64 镜像标签均不存在。
- 工具使用的 `movie-harbor-offline-*` 临时目录无残留。
- 没有伪造归档 SHA-256、allowlist 或 `images.tar` 平台结果。

## 尚缺正式证据

- 原生 `x86_64` / `linux/amd64` 构建机或 CI 上成功生成真实归档。
- 独立核对归档 allowlist 和 SHA-256。
- 独立导入 `images.tar` 并确认三个精确标签均为 `linux/amd64`。
- Windows 11 64 位 Intel i7-8700K + Docker Desktop WSL2/Linux containers 实机验收。

阻塞结论：当前宿主与 Docker daemon 均为 AArch64，且补充性质的模拟构建受 Docker Hub 网络超时阻断，不能据此签署正式 AMD64 或 Windows 11 验收。
