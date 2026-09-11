FROM rust:1.91-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN cargo build --locked --release -p movie-harbor-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 movie-harbor \
    && useradd --uid 10001 --gid movie-harbor --no-create-home --shell /usr/sbin/nologin movie-harbor
COPY --from=builder /src/target/release/movie-harbor-api /usr/local/bin/movie-harbor-api
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["movie-harbor-api"]
