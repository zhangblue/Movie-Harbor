# ARM64 本机工具链构建实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 ARM64 半离线打包直接使用本机已安装的 Rust、cargo-zigbuild 和 Zig，不限制精确版本，同时保留可用性、target、产物和清理校验。

**架构：** ARM64 前置检查执行三个独立版本命令并要求成功、非空，然后打印实际版本；只对 `aarch64-unknown-linux-musl` target 保持硬性检查。编译、ELF 校验、临时上下文和 AMD64 容器路径保持原样。

**技术栈：** Node.js ESM、Node Test Runner、Rust、cargo-zigbuild、Zig、Docker Buildx。

---

依据：`../specs/2026-11-01-arm64-local-toolchain-design.md`。

## 文件结构

- 修改 `tools/offline-package.mjs`：把精确版本断言改为非空版本探测并输出实际工具版本。
- 修改 `tests/offline-package.test.mjs`：接受本机任意非空版本，覆盖空输出、命令缺失、target 缺失和版本日志。
- 修改 `docs/guides/offline-package.md`：说明直接使用本机环境，不再要求固定版本；补充 `file` 命令依赖。
- 修改 `tests/documentation.test.mjs`：锁定本机工具链策略、有效检查命令和 Linux-only 边界。

### 任务 1：放宽 ARM64 宿主机版本门禁

**文件：**
- 修改：`tests/offline-package.test.mjs`
- 修改：`tools/offline-package.mjs`

- [ ] 先修改测试 fixture，让成功模式返回本机风格的 `rustc 1.99.1`、`cargo-zigbuild 0.24.0`、`0.17.0-dev...`，并断言 CLI 成功且 stdout 打印三项实际版本；生产代码修改前运行 ARM64 成功测试，确认因精确版本断言而 RED。
- [ ] 将三个 `*-wrong-version` 模式改为 `*-empty-version`，命令成功但输出空白；断言空版本早失败且不构建 API 镜像。保留三个 `*-missing` 和 `target-missing` 模式。
- [ ] 在产品代码中用一个小函数拒绝空白输出，不解析或比较版本号；打印 Rust、cargo-zigbuild、Zig 的原始版本文本。保持 `cargo-zigbuild --version` 作为版本探测，保持 `cargo zigbuild ...` 作为编译命令。
- [ ] 运行：`node --test tests/offline-package.test.mjs tests/backend-build.test.mjs`。预期全部通过。
- [ ] 运行：`git diff --check`。预期无输出。
- [ ] 提交：`git commit -m "feat: use installed ARM64 build tools"`。

### 任务 2：同步指南并恢复真实验收

**文件：**
- 修改：`docs/guides/offline-package.md`
- 修改：`tests/documentation.test.mjs`
- 验证：任务 4 原验收清单中的全量测试、E2E 和双平台真实包

- [ ] 先修改文档契约，要求指南说明 ARM64 使用本机已安装环境、保留四条检查命令和 `rustup target add aarch64-unknown-linux-musl`，拒绝三个精确版本要求；运行文档测试确认 RED。
- [ ] 更新指南：删除精确版本安装/门禁，保留 `cargo-zigbuild --version` 检查与 target 安装，列出 `file` 为 ARM64 产物校验依赖；明确 AMD64 固定容器路径不变。
- [ ] 运行：`node --test tests/documentation.test.mjs tests/backend-build.test.mjs tests/offline-package.test.mjs` 和 `git diff --check`。预期全部通过。
- [ ] 提交：`git commit -m "docs: use local ARM64 build toolchain"`。
- [ ] 重新执行 `docs/superpowers/plans/2026-10-31-arm64-host-zigbuild.md` 任务 4，但工具链门禁改为：三个版本命令成功且非空、target 已安装；使用本机实际版本完成根 Node、Rust、PostgreSQL、前端、隔离 E2E、ARM64/AMD64 真实包、镜像平台、运行用户、ELF 静态链接、校验和与不覆盖验证。
