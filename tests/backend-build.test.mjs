import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../backend/Dockerfile", import.meta.url), "utf8");

function stage(name) {
  const sections = dockerfile.split(/^FROM /m).slice(1);
  const section = sections.find((value) => new RegExp(` AS ${name}\\n`).test(value));
  assert.ok(section, `missing build stage ${name}`);
  return section;
}

test("ARM64 backend retains the target-platform GNU Cargo build", () => {
  const arm = stage("builder-arm64");
  assert.match(arm, /^rust:1\.91-bookworm AS builder-arm64/);
  assert.match(arm, /cargo build --locked --release -p movie-harbor-api/);
  assert.doesNotMatch(arm, /zig|musl|--target|--platform=\$BUILDPLATFORM/);
  assert.match(arm, /target\/release\/movie-harbor-api \/out\/movie-harbor-api/);
});

test("AMD64 backend cross-compiles musl on the native build platform with pinned tools", () => {
  const amd = stage("builder-amd64");
  assert.match(amd, /^--platform=\$BUILDPLATFORM rust:1\.91-bookworm AS builder-amd64/);
  assert.match(amd, /ziglang==0\.15\.2/);
  assert.match(amd, /cargo install --locked cargo-zigbuild --version 0\.23\.4/);
  assert.match(amd, /rustup target add x86_64-unknown-linux-musl/);
  assert.match(amd, /cargo zigbuild --locked --release --target x86_64-unknown-linux-musl -p movie-harbor-api/);
  assert.match(amd, /target\/x86_64-unknown-linux-musl\/release\/movie-harbor-api \/out\/movie-harbor-api/);
});

test("runtime selects the requested architecture and preserves Debian non-root deployment", () => {
  assert.match(dockerfile, /FROM builder-\$\{TARGETARCH\} AS builder/);
  const runtime = stage("runtime");
  assert.match(runtime, /^debian:bookworm-slim AS runtime/);
  assert.match(runtime, /ca-certificates curl/);
  assert.match(runtime, /COPY --from=builder \/out\/movie-harbor-api \/usr\/local\/bin\/movie-harbor-api/);
  assert.match(runtime, /USER 10001:10001/);
  assert.match(runtime, /ENTRYPOINT \["movie-harbor-api"\]/);
});
