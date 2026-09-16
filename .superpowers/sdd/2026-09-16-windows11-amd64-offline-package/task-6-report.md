# Task 6 报告：Windows 11 AMD64 部署指南与验收模板

## 状态

**PARTIAL / BLOCKED，不得标记为 complete。**

本机可完成的文档、契约测试和完整回归已经执行。以下正式外部证据仍缺失：

- 原生 AMD64 Linux 构建机或 CI 上成功生成真实 AMD64 归档，并记录 allowlist、外层 SHA-256 和三个镜像的 `linux/amd64` 检查结果。
- Windows 11 64 位、Intel i7-8700K、Docker Desktop WSL2/Linux containers 上的包导入、启动、双物理硬盘业务流程与隔离失败路径证据。

## 变更

- `README.md`
  - 增加 ARM64 与 AMD64 两个单平台构建命令、产物名称和原生 AMD64 正式证据边界。
  - 增加 Windows 11 Docker Desktop WSL2/Linux containers 前置条件，以及 PowerShell 解压、校验导入、`.env` 和 `start.ps1` 流程。
  - 明确 Windows 正斜杠绝对盘符路径、多卷只允许末尾追加、官方镜像联网要求、`/admin/`、局域网 HTTPS 与失败恢复规则。
  - 将 ARM64 部署改为经 `start.sh` 完成相同的多卷登记和生成覆盖配置，不再指导直接绕过入口启动基础 Compose。
- `AGENTS.md`
  - 加入 Windows AMD64 设计与计划索引。
  - 将半离线发布边界更新为两个单平台包，并锁定原生 AMD64 与 Windows 11 Intel 实机的证据要求。
- `docs/verification/windows11-amd64-package.md`
  - 保留 Task 5 已取得的本机补充事实。
  - 明确正式构建 `BLOCKED`、Windows 实机 `PENDING`，不预填任何成功结果。
  - 增加可执行的环境、构建、包校验、PowerShell 部署、双物理硬盘选择、容器重建、启动恢复和失败路径记录字段。
- `tests/offline-package.test.mjs`
  - 增加仓库级文档契约，防止双平台命令、Windows 前置、PowerShell 流程、路径规则、安全提示或外部证据状态回退。

## TDD 记录

RED：新增仓库部署文档契约后，运行：

```bash
node --test --test-name-pattern='repository deployment docs' tests/offline-package.test.mjs
```

结果为 1 项失败；首个明确缺口是 README 不包含 `./tools/build-offline-package.sh --platform linux/arm64`，证明测试能够捕获旧的 ARM64-only 文档。

GREEN：完成 README、AGENTS 与验收记录后重跑同一命令，1/1 通过。

## 本地完整回归

以下均为本次变更后的新鲜结果：

- `docker compose -f docker-compose.test.yml up -d postgres`：通过，隔离 PostgreSQL 正常运行。
- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `TEST_DATABASE_URL=... cargo test --workspace`：最终完整重跑通过，共 227 项测试。
  - 首次受限执行因沙箱禁止访问本机 PostgreSQL 而失败。
  - 获准连接后第一次完整运行出现一项 `auth_test` 媒体卷初始化偶发失败；该项聚焦重跑通过，随后完整工作区重新运行全部通过。未据此修改与 Task 6 无关的后端代码。
- `npm test --workspaces`：通过，共 209 项测试。
- `npm run build --workspaces`：通过。
- `node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs`：98 项通过、27 项跳过、0 失败；跳过项要求 Windows PowerShell 或真实 Linux UID/容器环境。
- `npm run test:e2e`：通过，共 7 项浏览器验收；隔离 Compose 项目和数据已完成安全清理。
- `npm run test:package`：61 项通过、22 项 Windows PowerShell 行为测试因当前非 Windows 宿主明确跳过、0 失败。
- `git diff --check`：通过。

## 外部阻塞

当前主机与 Docker daemon 都是 AArch64，不能提供计划要求的原生 AMD64 正式构建证据；Task 5 的模拟构建又曾受 Docker Hub OAuth token 超时阻断。当前也未连接用户的 Windows 11 Intel i7-8700K 实机和两块物理硬盘。因此只能交付可执行指南与验收模板，不能签署 Task 5 或 Task 6 complete。
