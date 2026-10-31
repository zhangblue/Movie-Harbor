# ARM64 宿主机 cargo-zigbuild 构建设计

日期：2026-10-31

## 变更范围

本增量规格只调整 `linux/arm64` 半离线发布包的 Rust 后端构建方式。它覆盖 `2026-10-27-amd64-musl-build-design.md` 中“ARM64 使用目标平台容器与普通 GNU Cargo 构建”的约定；AMD64 musl 构建、发布包结构、镜像标签、部署接口和应用行为保持不变。

构建机可以是 macOS Apple Silicon 或 Linux，但产物仅面向 `linux/arm64`。本次不生成 macOS 原生程序，不承诺在 Mac 上部署或运行 Movie Harbor，也不增加 Docker Desktop、OrbStack 或 macOS 加载脚本的兼容边界。

## 目标

- ARM64 后端在宿主机上直接交叉编译，不再在 ARM64 构建容器中运行 Cargo。
- 使用固定的 `aarch64-unknown-linux-musl` 目标产生 Linux ARM64 静态程序，降低运行镜像与构建环境的 libc 耦合。
- 保留现有一条命令的半离线打包入口，由发布工具编排宿主机编译、运行镜像组装、平台检查、导出和归档。
- 保证每次打包使用本次编译的程序，不读取仓库现有 `target/` 或历史构建结果。

## 工具链与编译命令

构建机必须预先安装并满足：

- Rust 1.91；
- cargo-zigbuild 0.23.4；
- Zig 0.15.2；
- Rust target `aarch64-unknown-linux-musl`；
- Docker Engine、Docker Buildx 与 Docker Compose v2。

发布工具只做前置检查并在不满足时给出明确错误，不自动安装、更新或修改宿主机工具链。

ARM64 打包时执行：

```bash
cargo zigbuild \
  --locked \
  --release \
  --target aarch64-unknown-linux-musl \
  --target-dir "$arm64_target_dir" \
  -p movie-harbor-api
```

`arm64_target_dir` 是发布工具为本次运行创建的内部绝对路径。程序位于该目录下的 `aarch64-unknown-linux-musl/release/movie-harbor-api`。不得回退到普通 `cargo build`、GNU 目标或仓库 `target/` 中的程序。

## 打包架构

`tools/offline-package.mjs` 仍是唯一半离线打包编排入口。当平台为 `linux/arm64` 时，它按以下顺序执行：

1. 检查宿主机 Rust、cargo-zigbuild、Zig、ARM64 musl target 与 Docker 能力。
2. 在本次 `mkdtemp` 安全临时目录中运行上述 cargo-zigbuild 命令。
3. 检查输出是 ARM64 Linux ELF，且是 musl 静态链接程序。
4. 创建仅含该程序的临时 API 镜像构建上下文。
5. 使用独立的预编译 API 运行镜像 Dockerfile 组装 `linux/arm64` 镜像。
6. 前端两个镜像仍使用现有 Dockerfile 与 Buildx 按目标平台构建。
7. 沿用现有镜像平台检查、`docker image save`、归档白名单、包内 SHA-256 和原子发布流程。

预编译 API 运行镜像继续使用 `debian:bookworm-slim`，保留 CA 证书、curl、`10001:10001` 非 root 用户、端口和入口命令。该 Dockerfile 不含 Rust、Zig、Cargo 或源码构建阶段；它只从临时上下文复制本次已验证的程序。

AMD64 继续使用现有 `backend/Dockerfile` 中固定的 Rust 1.91、cargo-zigbuild 0.23.4、Zig 0.15.2 和 `x86_64-unknown-linux-musl` 容器构建，不纳入本次重构。开发与 E2E 可继续使用现有后端 Dockerfile；本变更只约束 ARM64 半离线发布路径。

## 临时资源与错误处理

- Rust target 目录、预编译镜像上下文和本次归档 staging 都位于工具创建的独立安全临时目录。
- 构建、中断、检查或归档失败时，保持现有中断传递和清理语义；不生成最终归档，不遗留伪成功产物。
- 工具版本、target 缺失、cargo-zigbuild 退出非零、产物缺失、ELF 架构或链接方式不符、Docker 镜像平台不符均立即失败。
- 最终输出仍只能写入被 Git 忽略的 `dist/offline/`，拒绝覆盖同名产物。
- 不修改或删除宿主机现有 Rust target、Cargo 缓存、Zig 安装、Docker 镜像或仓库现有 `target/`。

## 文档与兼容性

半离线发布指南将明确：

- ARM64 后端使用宿主机 cargo-zigbuild 生成 Linux ARM64 musl 程序；
- 构建机可为 macOS Apple Silicon 或 Linux，但输出和部署目标仅为 Linux ARM64；
- 如何安装或检查固定工具版本与 Rust target；
- AMD64 仍使用现有容器化 Zig musl 构建；
- 目标机仍需 Linux、Docker Engine、Docker Compose v2 和固定基础镜像，不新增 macOS 运行支持。

镜像标签、Compose 模板、归档结构、命名、平台参数和升级边界均不变，旧的 GNU ARM64 发布包不会被覆盖或改写。

## 测试与验收

实现遵循 TDD，至少覆盖：

1. 发布工具对 ARM64 选择宿主机 cargo-zigbuild，参数精确包含 `--locked --release --target aarch64-unknown-linux-musl -p movie-harbor-api`。
2. `--target-dir` 指向本次临时目录，不读写仓库 `target/`。
3. 宿主机工具链缺失或版本错误时早失败，且不调用 Docker 构建 API 镜像。
4. 产物缺失、非 ARM64 Linux ELF 或非静态链接时失败。
5. 预编译运行 Dockerfile 不包含源码、Rust 或 Zig，并保留当前 Debian 运行依赖、非 root 用户和入口。
6. AMD64 路径继续使用现有容器构建命令，不受 ARM64 变更影响。
7. 真实构建 ARM64 程序和运行镜像，检查 ELF 架构、静态链接、镜像 `linux/arm64` 和 `10001:10001` 运行用户。
8. 分别构建 ARM64、AMD64 唯一版本半离线归档，验证标签、白名单、包内校验和不覆盖规则。
9. 运行根 Node 契约、Rust 格式与静态检查、相关 Rust 测试、全部前端测试与构建、隔离 Docker Compose 与 Playwright E2E。

## 非目标

- macOS 原生可执行程序或 Mac 部署包。
- 在 Apple Silicon Mac 上运行、部署或验收 Movie Harbor。
- 完全取消 Docker；Docker 仍用于组装三个自研镜像和生成现有半离线归档。
- 修改 AMD64 编译目标或工具链。
- 改变发布包的部署接口、数据目录、基础镜像边界或应用行为。
- 覆盖、替换或重发已有 tag 和 Release 附件。
