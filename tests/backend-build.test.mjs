import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../backend/Dockerfile", import.meta.url), "utf8");
const prebuiltDockerfile = readFileSync(
  new URL("../backend/Dockerfile.prebuilt", import.meta.url),
  "utf8",
);

function stage(name) {
  const sections = dockerfile.split(/^FROM /m).slice(1);
  const section = sections.find((value) => new RegExp(` AS ${name}\\n`).test(value));
  assert.ok(section, `missing build stage ${name}`);
  return section;
}

test("AMD64 backend cross-compiles musl on the native build platform with pinned tools", () => {
  const amd = stage("builder-amd64");
  assert.match(amd, /^--platform=\$BUILDPLATFORM rust:1\.91-bookworm AS builder-amd64/);
  assert.match(amd, /ziglang==0\.15\.2/);
  assert.match(amd, /cargo install --locked cargo-zigbuild --version 0\.23\.4/);
  assert.match(amd, /rustup target add x86_64-unknown-linux-musl/);
  assert.match(
    amd,
    /cargo zigbuild --locked --release --target x86_64-unknown-linux-musl -p movie-harbor-api/,
  );
  assert.match(amd, /target\/x86_64-unknown-linux-musl\/release\/movie-harbor-api \/out\/movie-harbor-api/);
});

test("prebuilt backend image only assembles the verified binary in the Debian runtime", () => {
  assert.match(prebuiltDockerfile, /^FROM debian:bookworm-slim AS runtime/m);
  assert.match(prebuiltDockerfile, /ca-certificates curl/);
  assert.match(
    prebuiltDockerfile,
    /COPY movie-harbor-api \/usr\/local\/bin\/movie-harbor-api/,
  );
  assert.match(prebuiltDockerfile, /USER 10001:10001/);
  assert.match(prebuiltDockerfile, /EXPOSE 3000/);
  assert.match(prebuiltDockerfile, /ENTRYPOINT \["movie-harbor-api"\]/);
  assert.doesNotMatch(prebuiltDockerfile, /\brust\b|cargo|zig|backend\/src|COPY Cargo/iu);
});

test("runtime selects the requested architecture and preserves the Debian non-root development image", () => {
  assert.match(dockerfile, /FROM builder-\$\{TARGETARCH\} AS builder/);
  const runtime = stage("runtime");
  assert.match(runtime, /^debian:bookworm-slim AS runtime/);
  assert.match(runtime, /ca-certificates curl/);
  assert.match(runtime, /COPY --from=builder \/out\/movie-harbor-api \/usr\/local\/bin\/movie-harbor-api/);
  assert.match(runtime, /USER 10001:10001/);
  assert.match(runtime, /ENTRYPOINT \["movie-harbor-api"\]/);
});
