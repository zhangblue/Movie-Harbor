FROM rust:1.91-bookworm AS builder-arm64
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN cargo build --locked --release -p movie-harbor-api \
    && mkdir /out \
    && cp target/release/movie-harbor-api /out/movie-harbor-api

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
RUN cargo zigbuild --locked --release --target x86_64-unknown-linux-musl -p movie-harbor-api \
    && mkdir /out \
    && cp target/x86_64-unknown-linux-musl/release/movie-harbor-api /out/movie-harbor-api

FROM builder-${TARGETARCH} AS builder

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
