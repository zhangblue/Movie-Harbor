import assert from "node:assert/strict";
import test from "node:test";

import {
  imageTags,
  normalizePlatform,
  renderBundleReadme,
  renderCompose,
  renderLoadScript,
  validateVersion,
} from "../tools/offline-package.mjs";

const VERSION = "test-v1";

test("validates the release version against a strict tag-safe whitelist", () => {
  assert.equal(validateVersion("v1.2.3-rc_1"), "v1.2.3-rc_1");
  assert.throws(() => validateVersion("../secret"), /invalid version/);
  assert.throws(() => validateVersion("release version"), /invalid version/);
  assert.throws(() => validateVersion(""), /invalid version/);
});

test("normalizes only the supported Linux ARM64 Docker platform", () => {
  assert.equal(normalizePlatform("linux", "aarch64"), "linux/arm64");
  assert.equal(normalizePlatform("linux", "arm64"), "linux/arm64");
  assert.throws(() => normalizePlatform("linux", "x86_64"), /only supports linux\/arm64/);
  assert.throws(() => normalizePlatform("darwin", "arm64"), /only supports linux\/arm64/);
});

test("uses the three exact self-hosted image tags", () => {
  assert.deepEqual(imageTags(VERSION), [
    "movie-harbor-api:test-v1-linux-arm64",
    "movie-harbor-public-web:test-v1-linux-arm64",
    "movie-harbor-admin-web:test-v1-linux-arm64",
  ]);
});

test("renders an image-only Compose deployment with the production topology", () => {
  const compose = JSON.parse(renderCompose(VERSION));

  assert.equal(compose.name, "movie-harbor");
  assert.equal(compose.services.api.image, "movie-harbor-api:test-v1-linux-arm64");
  assert.equal(compose.services["public-web"].image, "movie-harbor-public-web:test-v1-linux-arm64");
  assert.equal(compose.services["admin-web"].image, "movie-harbor-admin-web:test-v1-linux-arm64");
  for (const service of ["api", "public-web", "admin-web"]) {
    assert.equal(compose.services[service].pull_policy, "never");
  }

  assert.equal(compose.services.postgres.image, "postgres:17-alpine");
  assert.equal(compose.services["media-init"].image, "alpine:3.22");
  assert.equal(compose.services.caddy.image, "caddy:2.10-alpine");
  for (const service of ["postgres", "media-init", "caddy"]) {
    assert.equal(Object.hasOwn(compose.services[service], "pull_policy"), false);
  }

  for (const service of Object.values(compose.services)) {
    assert.equal(Object.hasOwn(service, "build"), false);
    for (const volume of service.volumes ?? []) {
      if (typeof volume === "string") continue;
      assert.equal(volume.source.includes("backend"), false);
      assert.equal(volume.source.includes("frontend"), false);
      assert.equal(volume.source.includes("src"), false);
      assert.equal(volume.source.includes("node_modules"), false);
      assert.equal(volume.source.includes("target"), false);
    }
  }

  assert.deepEqual(compose.services.postgres, {
    image: "postgres:17-alpine",
    restart: "unless-stopped",
    environment: {
      POSTGRES_DB: "${POSTGRES_DB:?set POSTGRES_DB}",
      POSTGRES_USER: "${POSTGRES_USER:?set POSTGRES_USER}",
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}",
    },
    volumes: [{
      type: "bind",
      source: "${DATABASE_HOST_DIR:-./data/postgres}",
      target: "/var/lib/postgresql/data",
      bind: { create_host_path: true },
    }],
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"],
      interval: "5s",
      timeout: "5s",
      retries: 20,
      start_period: "10s",
    },
  });
  assert.deepEqual(compose.services["media-init"], {
    image: "alpine:3.22",
    restart: "no",
    command: ["sh", "-c", "chown 10001:10001 /media && chmod 0700 /media"],
    volumes: [{
      type: "bind",
      source: "${MEDIA_HOST_DIR:-./data/media}",
      target: "/media",
      bind: { create_host_path: true },
    }],
  });
  assert.deepEqual(compose.services.api, {
    image: "movie-harbor-api:test-v1-linux-arm64",
    pull_policy: "never",
    restart: "unless-stopped",
    depends_on: {
      postgres: { condition: "service_healthy" },
      "media-init": { condition: "service_completed_successfully" },
    },
    environment: {
      LISTEN_ADDR: "0.0.0.0:3000",
      DATABASE_HOST: "postgres",
      DATABASE_PORT: "5432",
      POSTGRES_DB: "${POSTGRES_DB:?set POSTGRES_DB}",
      POSTGRES_USER: "${POSTGRES_USER:?set POSTGRES_USER}",
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}",
      MEDIA_DIR: "/media",
      COOKIE_SECURE: "${COOKIE_SECURE:-true}",
      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN}",
      TRUST_PROXY_HEADERS: "true",
      TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
      MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-5368709120}",
      VIDEO_MIME_ALLOWLIST: "${VIDEO_MIME_ALLOWLIST:-video/mp4,video/webm}",
      ADMIN_NAME: "${ADMIN_NAME:-}",
      ADMIN_INITIAL_PASSWORD: "${ADMIN_INITIAL_PASSWORD:-}",
    },
    volumes: [{
      type: "bind",
      source: "${MEDIA_HOST_DIR:-./data/media}",
      target: "/media",
      bind: { create_host_path: true },
    }],
    healthcheck: {
      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:3000/api/health"],
      interval: "5s",
      timeout: "5s",
      retries: 20,
      start_period: "10s",
    },
  });
  assert.deepEqual(compose.services.caddy, {
    image: "caddy:2.10-alpine",
    restart: "unless-stopped",
    environment: { TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}" },
    depends_on: {
      api: { condition: "service_healthy" },
      "public-web": { condition: "service_healthy" },
      "admin-web": { condition: "service_healthy" },
    },
    ports: ["${APP_PORT:-8080}:80"],
    volumes: [
      "./Caddyfile:/etc/caddy/Caddyfile:ro",
      {
        type: "bind",
        source: "${MEDIA_HOST_DIR:-./data/media}",
        target: "/srv/media",
        read_only: true,
        bind: { create_host_path: true },
      },
    ],
    healthcheck: {
      test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/api/health"],
      interval: "5s",
      timeout: "5s",
      retries: 10,
    },
  });
  assert.deepEqual(compose.services["public-web"].healthcheck, {
    test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/"],
    interval: "5s",
    timeout: "5s",
    retries: 10,
  });
  assert.deepEqual(compose.services["admin-web"].healthcheck, {
    test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/admin/"],
    interval: "5s",
    timeout: "5s",
    retries: 10,
  });
});

test("renders a loader that verifies before importing and checks all images", () => {
  const script = renderLoadScript(VERSION);
  const checksum = script.indexOf("sha256sum -c SHA256SUMS");
  const load = script.indexOf("docker image load -i images.tar");

  assert.ok(checksum >= 0);
  assert.ok(load > checksum);
  for (const tag of imageTags(VERSION)) {
    assert.match(script, new RegExp(tag));
  }
  assert.match(script, /linux\/arm64/);
  assert.match(script, /docker image inspect/);
});

test("renders deployment guidance that keeps official images online", () => {
  const readme = renderBundleReadme(VERSION);

  assert.match(readme, /Docker Hub/);
  assert.match(readme, /联网/);
  assert.match(readme, /postgres:17-alpine/);
  assert.match(readme, /alpine:3\.22/);
  assert.match(readme, /caddy:2\.10-alpine/);
  assert.match(readme, /linux\/arm64/);
  assert.match(readme, /test-v1/);
});
