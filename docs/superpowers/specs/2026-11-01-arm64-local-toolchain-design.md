# ARM64 本机工具链构建设计

日期：2026-11-01

## 变更范围

本增量规格调整 `2026-10-31-arm64-host-zigbuild-design.md` 中 ARM64 宿主机工具链的版本策略。ARM64 继续由宿主机执行 cargo-zigbuild，但不再要求 Rust 1.91、cargo-zigbuild 0.23.4 和 Zig 0.15.2 精确匹配；构建直接使用当前 `PATH` 和 rustup 环境中已安装的工具。

AMD64 仍使用 `backend/Dockerfile` 中固定版本的容器化 Rust、cargo-zigbuild 和 Zig，本规格不改变 AMD64 构建方式。

## 前置检查

ARM64 半离线打包前必须执行并记录：

```bash
rustc --version
cargo-zigbuild --version
zig version
rustup target list --installed
```

前三条命令必须成功并返回非空版本文本，但发布工具不比较或限制具体版本号。target 列表仍必须包含 `aarch64-unknown-linux-musl`。工具或 target 缺失时在 Docker API 镜像构建前失败；发布工具不自动安装、升级或切换宿主机工具链。

cargo-zigbuild 官方负责校验其支持的 Zig 最低版本和实际兼容性。发布工具不重复实现 Zig 语义版本比较，也不拒绝开发版版本字符串。

## 编译与产物

ARM64 编译命令保持不变：

```bash
cargo zigbuild \
  --locked \
  --release \
  --target aarch64-unknown-linux-musl \
  --target-dir "$arm64_target_dir" \
  -p movie-harbor-api
```

临时 target、ELF 架构与静态链接校验、预编译 Docker 上下文、进程组中断清理、镜像组装、归档白名单、校验和和原子发布规则均保持不变。

## 文档与可追溯性

发布指南说明 ARM64 直接使用本机已安装环境，提供检查命令和 target 安装命令，但不再要求或安装三个精确工具版本。每次真实打包的标准输出必须打印实际 Rust、cargo-zigbuild 和 Zig 版本，便于记录构建环境。

构建结果仍只支持 Linux ARM64；使用 Apple Silicon macOS 作为构建机不会生成 macOS 原生程序。

## 测试与验收

- 任意非空的本机 Rust、cargo-zigbuild 和 Zig 版本输出可通过前置检查。
- 工具命令失败、版本输出为空或 ARM64 musl target 缺失时早失败。
- 标准输出包含本次实际使用的三个工具版本。
- 真正编译仍使用精确的 ARM64 musl Cargo 参数和临时 target 目录。
- AMD64 不调用宿主机 Rust、cargo-zigbuild 或 Zig，继续使用原容器构建。
- 使用当前本机工具链完成 ARM64 真实程序、镜像、半离线包和全量回归验收。

## 非目标

- 自动安装或升级 Rust、cargo-zigbuild、Zig 或 Rust target。
- 为任意未来工具版本承诺兼容；真实构建失败仍会阻止发布。
- 改变 AMD64 固定容器工具链。
- 增加 macOS 运行或部署支持。
