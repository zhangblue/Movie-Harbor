# AMD64 musl 后端构建设计

日期：2026-10-27

## 用户要求与范围

ARM64 继续使用 `aarch64-unknown-linux-gnu`；仅将 AMD64 后端改为 `x86_64-unknown-linux-musl`。本增量补充既有 AMD64 半离线规格的构建策略，不改变部署接口或内容行为。

## 构建边界

后端 Dockerfile 为两个架构定义独立构建阶段，通过 BuildKit 自动变量 `TARGETARCH` 选择。ARM64 保留 `rust:1.91-bookworm` 和普通 `cargo build --locked --release -p movie-harbor-api`，不安装 Zig。AMD64 固定在 `BUILDPLATFORM` 原生 Linux 容器中执行，固定 Rust 1.91、cargo-zigbuild 0.23.4 和 Zig 0.15.2，添加 musl target 后执行用户指定的 zigbuild 命令。

两个阶段统一将程序放到 `/out/movie-harbor-api`。运行阶段继续使用目标平台 Debian，保留 curl、证书、10001 用户和现有入口。构建失败直接停止，不回退 GNU。前端保持既有构建。默认 ARM64、平台参数、镜像标签、归档白名单与半离线边界不变。不替换已发布 v0.3 附件，不部署生产服务器。

## 验证

配置契约约束两个编译分支及运行容器权限。实际构建两个架构镜像，提取程序验证 ELF 架构和静态或动态链接；运行隔离 Compose 和 Playwright E2E，并构建唯一版本的双平台归档验证打包接口。仅修改 Dockerfile、相关测试和文档，无 Rust 业务代码或迁移变更。
