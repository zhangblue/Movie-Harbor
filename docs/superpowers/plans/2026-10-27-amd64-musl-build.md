# AMD64 musl 后端构建实现计划

依据：`../specs/2026-10-27-amd64-musl-build-design.md`。

1. 添加 `tests/backend-build.test.mjs`，确认原 Dockerfile 缺少架构分阶段而失败；分别断言 ARM64 普通 Cargo 命令、AMD64 固定原生 Zig 工具链和 musl 命令、运行阶段及用户权限。
2. 在 `backend/Dockerfile` 添加独立构建阶段，通过 `FROM builder-${TARGETARCH}` 选择程序，统一输出路径；运行阶段保持 Debian。
3. 更新半离线发布指南中的编译目标、工具版本及跨架构模拟边界。
4. 实际构建 AMD64、ARM64 镜像，提取程序检查架构和链接方式；运行根 Node 契约、文档检查、隔离 E2E、唯一版本双平台发布验证和 `git diff --check`。
5. 独立审查最终差异；不修改既有 v0.3 Release 或生产部署。

## 实际验证记录

- 根 Node 契约 229 项通过；双平台镜像和唯一版本 `musl-check-20261027` 半离线包均构建成功，归档白名单、包内校验和及三个镜像的平台检查通过。
- 提取镜像程序确认 ARM64 是 GNU 动态链接 ELF，AMD64 是 x86-64 静态链接 ELF；运行用户保持 `10001:10001`。
- ARM64 完整 E2E 19 项及重启持久化 1 项通过。
- AMD64 完整 E2E 中 `late logout response preserves a newer viewer cookie and UI` 超时；使用同一环境和已发布 v0.3 GNU 程序作对照，也在该处失败。未修改业务逻辑或放宽断言。
- 显式选择各项目并排除上述单项后，AMD64 其余 18 项通过；固定工具链生成的 musl 程序在 Debian 和 Alpine x86_64 容器中通过迁移、管理员初始化、登录会话、数据库读写和重启持久化冒烟验证。
- 运行环境为 ARM Mac 上的 x86_64 Linux 容器，未将结果表述为原生 AMD64 主机验收。
