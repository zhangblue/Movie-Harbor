# ARM64 镜像构建时使用目标平台工具链，锁定依赖后生成供运行阶段复制的后端程序。
FROM rust:1.91-bookworm AS builder-arm64
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN cargo build --locked --release -p movie-harbor-api \
    && mkdir /out \
    && cp target/release/movie-harbor-api /out/movie-harbor-api

# AMD64 构建在构建机平台安装固定版本 Zig 与交叉编译工具，避免在模拟目标平台中编译。
FROM --platform=$BUILDPLATFORM rust:1.91-bookworm AS builder-amd64
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/zig \
    && /opt/zig/bin/pip install --no-cache-dir ziglang==0.15.2
ENV PATH="/opt/zig/bin:${PATH}"
RUN cargo install --locked cargo-zigbuild --version 0.23.4 \
    && rustup target add x86_64-unknown-linux-musl
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
# 交叉编译 Linux AMD64 的 musl 程序，后续运行镜像只接收产物，不包含编译工具链。
RUN cargo zigbuild --locked --release --target x86_64-unknown-linux-musl -p movie-harbor-api \
    && mkdir /out \
    && cp target/x86_64-unknown-linux-musl/release/movie-harbor-api /out/movie-harbor-api

# 由镜像构建的目标架构选中对应阶段，两个平台均提供相同的产物路径。
FROM builder-${TARGETARCH} AS builder

# 运行阶段安装证书及健康检查工具，并以固定普通用户启动后端，避免保留构建依赖。
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 movie-harbor \
    && useradd --uid 10001 --gid movie-harbor --no-create-home --shell /usr/sbin/nologin movie-harbor
COPY --from=builder /out/movie-harbor-api /usr/local/bin/movie-harbor-api
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["movie-harbor-api"]
