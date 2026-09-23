import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  imageTags,
  normalizePlatform,
  renderBundleReadme,
  renderCompose,
  renderLoadScript,
  validateVersion,
} from "../tools/offline-package.mjs";

const VERSION = "test-v1";
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLE_NAME = "movie-harbor-offline-linux-arm64-test-v1.tar.gz";
const BUNDLE_ENTRIES = [
  "movie-harbor/", "movie-harbor/.env.example", "movie-harbor/Caddyfile",
  "movie-harbor/README.md", "movie-harbor/SHA256SUMS",
  "movie-harbor/compose.yml", "movie-harbor/images.tar",
  "movie-harbor/load-images.sh",
];

// Only Docker is replaced: its save boundary still emits a real tar archive.
const DOCKER_DOUBLE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const mode = process.env.DOCKER_TEST_MODE;
const targetPlatform = process.env.DOCKER_TEST_PLATFORM;
fs.appendFileSync(process.env.DOCKER_TEST_LOG, JSON.stringify(args) + '\\n');
function fail(message) { console.error(message); process.exit(1); }
if (args[0] === 'info') {
  if (mode === 'docker-down') fail('Docker daemon unavailable');
  console.log(mode === 'wrong-host' ? 'linux/arm64' : 'linux/aarch64');
} else if (args[0] === 'buildx' && args[1] === 'version') {
  if (mode === 'buildx-down') fail('Buildx unavailable');
  console.log('github.com/docker/buildx v0.27.0');
} else if (args[0] === 'compose' && args[1] === 'version') {
  if (mode === 'compose-down') fail('Compose unavailable');
  console.log(mode === 'compose-new-major' ? '5.1.2' : '2.39.1');
} else if (args[0] === 'buildx' && args[1] === 'build') {
  if (!args.includes('--load')) fail('Expected a loaded single-platform image');
  if (args[args.indexOf('--platform') + 1] !== targetPlatform) fail('Wrong build platform');
  if (!fs.existsSync(args[args.indexOf('--file') + 1])) fail('Dockerfile unavailable in build context');
  if (mode === 'build-fails') fail('Build failed');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  if (mode === 'inspect-fails') fail('Image missing');
  console.log(mode === 'wrong-image' ? (targetPlatform === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64') : targetPlatform);
} else if (args[0] === 'image' && args[1] === 'save') {
  if (args[2] !== '--output') fail('Expected explicit output');
  const output = args[3];
  let tags = args.slice(4);
  if (mode === 'save-fails') {
    fs.writeFileSync(output, 'partial archive');
    fail('Save failed');
  }
  if (mode === 'wait-for-signal') {
    fs.writeFileSync(output, 'partial archive');
    console.error('SAVE_WAITING');
    setInterval(() => {}, 1000);
  } else {
    if (mode === 'extra-tag') tags.push('postgres:17-alpine');
    if (mode === 'missing-tag') tags.pop();
    if (mode === 'duplicate-tag') tags.push(tags[0]);
    const temp = fs.mkdtempSync(path.join(process.env.TMPDIR, 'docker-save-'));
    try {
      const manifest = tags.map(tag => ({ Config: 'config.json', RepoTags: [tag], Layers: ['layer.tar'] }));
      fs.writeFileSync(path.join(temp, 'manifest.json'), mode === 'bad-manifest' ? '{' : JSON.stringify(manifest));
      fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ os: 'linux', architecture: targetPlatform.split('/')[1] }));
      fs.writeFileSync(path.join(temp, 'layer.tar'), 'fixture runtime layer');
      const result = spawnSync('tar', ['-cf', output, '-C', temp, 'manifest.json', 'config.json', 'layer.tar']);
      if (result.status !== 0) fail('Fixture tar failed');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    if (mode === 'bad-tar') fs.writeFileSync(output, 'not a tar archive');
    if (mode === 'extra-staging-file') fs.writeFileSync(path.join(path.dirname(output), '.env'), 'secret');
    if (mode === 'symlink-staging-file') {
      fs.unlinkSync(path.join(path.dirname(output), 'Caddyfile'));
      fs.symlinkSync(process.env.DOCKER_TEST_LOG, path.join(path.dirname(output), 'Caddyfile'));
    }
    if (mode === 'publication-race') fs.writeFileSync(process.env.DOCKER_TEST_DESTINATION, 'other publisher');
  }
} else { fail('Unexpected Docker command: ' + args.join(' ')); }
`;

async function fixture(t, mode = "success", platform = "linux/arm64") {
  const root = await mkdtemp(join(tmpdir(), "offline-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo with spaces");
  const temporary = join(root, "temporary");
  const bin = join(root, "bin");
  await Promise.all([mkdir(repo), mkdir(temporary), mkdir(bin)]);
  for (const file of [
    "tools/offline-package.mjs", "tools/build-offline-package.sh", "Caddyfile", ".env.example",
    "backend/Dockerfile", "frontend/public-web/Dockerfile", "frontend/admin-web/Dockerfile",
  ]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await copyFile(join(REPO_ROOT, file), join(repo, file));
  }
  for (const file of [".git/private", ".env", "data/postgres/private", "media/private", "src/private", "tests/private"]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), "SECRET_DO_NOT_SHIP");
  }
  await writeFile(join(bin, "docker"), DOCKER_DOUBLE);
  await chmod(join(bin, "docker"), 0o755);
  const destination = join(repo, "dist/offline", `movie-harbor-offline-${platform.replace("/", "-")}-${VERSION}.tar.gz`);
  const log = join(root, "docker.log");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
    DOCKER_TEST_MODE: mode, DOCKER_TEST_PLATFORM: platform,
    DOCKER_TEST_LOG: log, DOCKER_TEST_DESTINATION: destination,
  };
  return {
    repo, root, temporary, destination, env,
    run: (args = [VERSION]) => spawnSync("sh", [join(repo, "tools/build-offline-package.sh"), ...args], {
      cwd: root, env, encoding: "utf8",
    }),
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

async function assertClean(f, expectedFiles = []) {
  // Apple Git may create its own xcrun cache in TMPDIR; check directories owned by this workflow.
  const staging = (await readdir(f.temporary)).filter(name => /^(movie-harbor-offline-|docker-save-)/.test(name));
  assert.deepEqual(staging, [], "temporary staging must be removed");
  const outputs = await readdir(join(f.repo, "dist/offline")).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(outputs.sort(), expectedFiles, "no partial or unexpected output remains");
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("shell CLI builds exactly three runtime images and publishes only the complete allowed bundle", async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  const save = calls.find(args => args[0] === "image" && args[1] === "save");
  assert.ok(save, "CLI must export the runtime images");
  const savedTags = save.slice(4);
  assert.deepEqual(savedTags, [
    "movie-harbor-api:test-v1-linux-arm64",
    "movie-harbor-public-web:test-v1-linux-arm64",
    "movie-harbor-admin-web:test-v1-linux-arm64",
  ]);
  const builds = calls.filter(args => args[0] === "buildx" && args[1] === "build");
  assert.equal(builds.length, 3);
  assert.deepEqual(builds.map(args => args[args.indexOf("--file") + 1]), [
    "backend/Dockerfile", "frontend/public-web/Dockerfile", "frontend/admin-web/Dockerfile",
  ]);
  assert.deepEqual(builds.map(args => args[args.indexOf("--tag") + 1]), savedTags);
  for (const args of builds) {
    assert.equal(args.includes("--load"), true);
    assert.equal(args[args.indexOf("--platform") + 1], "linux/arm64");
    assert.equal(args.at(-1), ".");
  }
  const archiveEntries = tar(["-tzf", f.destination]).trim().split("\n").sort();
  assert.deepEqual(archiveEntries, BUNDLE_ENTRIES);
  const unpacked = join(f.root, "unpacked");
  await mkdir(unpacked);
  tar(["-xzf", f.destination, "-C", unpacked]);
  const bundle = join(unpacked, "movie-harbor");
  const manifest = JSON.parse(tar(["-xOf", join(bundle, "images.tar"), "manifest.json"]));
  assert.deepEqual(manifest.flatMap(image => image.RepoTags), savedTags);
  const checksums = (await readFile(join(bundle, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.deepEqual(checksums.map(line => line.slice(66)).sort(), [
    ".env.example", "Caddyfile", "README.md", "compose.yml", "images.tar", "load-images.sh",
  ]);
  for (const line of checksums) {
    const content = await readFile(join(bundle, line.slice(66)));
    assert.equal(createHash("sha256").update(content).digest("hex"), line.slice(0, 64));
    assert.equal(content.includes("SECRET_DO_NOT_SHIP"), false);
  }
  const checksumVerification = spawnSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
    cwd: bundle, encoding: "utf8",
  });
  assert.equal(checksumVerification.status, 0, checksumVerification.stderr);
  assert.ok((await stat(join(bundle, "load-images.sh"))).mode & 0o111);
  await assertClean(f, [BUNDLE_NAME]);
});

test("shell CLI builds and packages a linux/amd64 release", async t => {
  const f = await fixture(t, "success", "linux/amd64");
  const result = f.run(["--platform", "linux/amd64", VERSION]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.destination.endsWith("movie-harbor-offline-linux-amd64-test-v1.tar.gz"), true);

  const calls = await f.calls();
  const builds = calls.filter(args => args[0] === "buildx" && args[1] === "build");
  assert.equal(builds.length, 3);
  for (const args of builds) {
    assert.equal(args.includes("--load"), true);
    assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
  }
  const savedTags = calls.find(args => args[0] === "image" && args[1] === "save").slice(4);
  assert.deepEqual(savedTags, [
    "movie-harbor-api:test-v1-linux-amd64",
    "movie-harbor-public-web:test-v1-linux-amd64",
    "movie-harbor-admin-web:test-v1-linux-amd64",
  ]);
  const unpacked = join(f.root, "unpacked");
  await mkdir(unpacked);
  tar(["-xzf", f.destination, "-C", unpacked]);
  const bundle = join(unpacked, "movie-harbor");
  const manifest = JSON.parse(tar(["-xOf", join(bundle, "images.tar"), "manifest.json"]));
  assert.deepEqual(manifest.flatMap(image => image.RepoTags), savedTags);
  const config = JSON.parse(tar(["-xOf", join(bundle, "images.tar"), "config.json"]));
  assert.deepEqual(config, { os: "linux", architecture: "amd64" });
  const compose = JSON.parse(await readFile(join(bundle, "compose.yml"), "utf8"));
  assert.deepEqual(["api", "public-web", "admin-web"].map(name => compose.services[name].image), savedTags);
  const loader = await readFile(join(bundle, "load-images.sh"), "utf8");
  const readme = await readFile(join(bundle, "README.md"), "utf8");
  assert.match(loader, /linux\/amd64/);
  assert.match(readme, /linux\/amd64/);
  for (const tag of savedTags) {
    assert.equal(loader.includes(tag), true);
    assert.equal(readme.includes(tag), true);
  }
  await assertClean(f, ["movie-harbor-offline-linux-amd64-test-v1.tar.gz"]);
});

test("shell CLI accepts an explicit linux/arm64 target", async t => {
  const f = await fixture(t);
  const result = f.run(["--platform", "linux/arm64", VERSION]);
  assert.equal(result.status, 0, result.stderr);
  await assertClean(f, [BUNDLE_NAME]);
});

test("shell CLI can build AMD64 from an ARM64 Docker daemon", async t => {
  const f = await fixture(t, "wrong-host", "linux/amd64");
  const result = f.run(["--platform", "linux/amd64", VERSION]);
  assert.equal(result.status, 0, result.stderr);
  await assertClean(f, ["movie-harbor-offline-linux-amd64-test-v1.tar.gz"]);
});

test("shell CLI rejects a non-target AMD64 image and leaves no artifact", async t => {
  const f = await fixture(t, "wrong-image", "linux/amd64");
  const result = f.run(["--platform", "linux/amd64", VERSION]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected.*linux\/amd64.*linux\/arm64/i);
  await assertClean(f);
});

for (const [args, error] of [
  [["../secret"], /invalid version/i], [["bad version"], /invalid version/i],
  [["one", "two"], /usage|argument/i], [["--output-dir", "elsewhere"], /usage|argument/i],
  [["--platform"], /usage|argument/i],
  [["--platform", "linux/amd64", "one", "two"], /usage|argument/i],
  [["--unknown"], /usage|argument/i],
]) {
  test(`shell CLI rejects invalid arguments ${JSON.stringify(args)} before Docker runs`, async t => {
    const f = await fixture(t);
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.deepEqual(await f.calls(), []);
    await assertClean(f);
  });
}

test("shell CLI explains supported platforms and usage for an unsupported target", async t => {
  const f = await fixture(t);
  const result = f.run(["--platform", "linux/386", VERSION]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /linux\/arm64.*linux\/amd64/i);
  assert.match(result.stderr, /Usage:.*--platform linux\/arm64\|linux\/amd64/);
  assert.deepEqual(await f.calls(), []);
  await assertClean(f);
});

test("shell CLI accepts a compatible Compose plugin with version 5.1.2", async t => {
  const f = await fixture(t, "compose-new-major");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tar(["-tzf", f.destination]).trim().split("\n").sort(), BUNDLE_ENTRIES);
  await assertClean(f, [BUNDLE_NAME]);
});

test("shell CLI rejects an unavailable Compose plugin before building", async t => {
  const f = await fixture(t, "compose-down");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Compose unavailable/);
  assert.equal((await f.calls()).some(args => args[0] === "buildx" && args[1] === "build"), false);
  await assertClean(f);
});

for (const [mode, error] of [
  ["docker-down", /Docker/i],
  ["buildx-down", /Buildx unavailable/i], ["build-fails", /Build failed/i],
  ["inspect-fails", /inspect|Image missing/i], ["wrong-image", /linux\/arm64/i],
  ["save-fails", /Save/i], ["extra-tag", /RepoTags|tags/i], ["missing-tag", /RepoTags|tags/i],
  ["duplicate-tag", /RepoTags|tags/i], ["bad-manifest", /JSON|manifest/i],
  ["bad-tar", /tar/i], ["extra-staging-file", /allowlist|whitelist|staging/i],
  ["symlink-staging-file", /regular file|staging/i],
]) {
  test(`shell CLI fails cleanly when ${mode}`, async t => {
    const f = await fixture(t, mode);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    await assertClean(f);
  });
}

test("shell CLI refuses an existing artifact before building and preserves its bytes", async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.destination), { recursive: true });
  await writeFile(f.destination, "previous release");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exists/i);
  assert.equal(await readFile(f.destination, "utf8"), "previous release");
  assert.equal((await f.calls()).some(args => args[0] === "buildx" && args[1] === "build"), false);
  await assertClean(f, [BUNDLE_NAME]);
});

test("shell CLI cannot overwrite an artifact that appears during packaging", async t => {
  const f = await fixture(t, "publication-race");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exists|EEXIST/i);
  assert.equal(await readFile(f.destination, "utf8"), "other publisher");
  await assertClean(f, [BUNDLE_NAME]);
});

test("shell CLI cleans partial exports after SIGTERM", { timeout: 10000 }, async t => {
  const f = await fixture(t, "wait-for-signal");
  const child = spawn("sh", [join(f.repo, "tools/build-offline-package.sh"), VERSION], {
    cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let waiting = false;
  child.stderr.on("data", chunk => {
    if (chunk.toString().includes("SAVE_WAITING")) {
      waiting = true;
      child.kill("SIGTERM");
    }
  });
  const [code] = await new Promise(resolve => child.on("close", (...args) => resolve(args)));
  assert.equal(waiting, true, "CLI must reach image export before interruption");
  assert.notEqual(code, 0);
  await assertClean(f);
});

test("shell CLI help succeeds without Docker or output", async t => {
  const f = await fixture(t, "docker-down");
  const result = f.run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build-offline-package\.sh.*\[.*\]/);
  assert.match(result.stdout, /--platform linux\/arm64\|linux\/amd64/);
  assert.deepEqual(await f.calls(), []);
  await assertClean(f);
});

test("shell CLI defaults to the repository's 12-character Git revision", async t => {
  const f = await fixture(t);
  await rm(join(f.repo, ".git"), { recursive: true });
  for (const args of [
    ["init", "--quiet"], ["add", "tools/offline-package.mjs"],
    ["-c", "user.name=Offline test", "-c", "user.email=offline@example.invalid", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: f.repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const revision = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: f.repo, encoding: "utf8" }).stdout.trim();
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  await assertClean(f, [`movie-harbor-offline-linux-arm64-${revision}.tar.gz`]);
});

test("validates the release version against a strict tag-safe whitelist", () => {
  const longestTagSafeVersion = "v".repeat(116);

  assert.equal(validateVersion("v1.2.3-rc_1"), "v1.2.3-rc_1");
  assert.equal(validateVersion(longestTagSafeVersion), longestTagSafeVersion);
  assert.throws(() => validateVersion("v".repeat(117)), /invalid version/);
  assert.throws(() => validateVersion("../secret"), /invalid version/);
  assert.throws(() => validateVersion("release version"), /invalid version/);
  assert.throws(() => validateVersion(""), /invalid version/);
});

test("accepts only the two supported target platforms", () => {
  assert.equal(normalizePlatform(), "linux/arm64");
  assert.equal(normalizePlatform("linux/arm64"), "linux/arm64");
  assert.equal(normalizePlatform("linux/amd64"), "linux/amd64");
  assert.throws(() => normalizePlatform("linux/386"), /linux\/arm64.*linux\/amd64/i);
});

test("uses the three exact self-hosted image tags", () => {
  assert.deepEqual(imageTags(VERSION), [
    "movie-harbor-api:test-v1-linux-arm64",
    "movie-harbor-public-web:test-v1-linux-arm64",
    "movie-harbor-admin-web:test-v1-linux-arm64",
  ]);
});

test("uses AMD64 image tags and templates when requested", () => {
  assert.deepEqual(imageTags("test-v1", "linux/amd64"), [
    "movie-harbor-api:test-v1-linux-amd64",
    "movie-harbor-public-web:test-v1-linux-amd64",
    "movie-harbor-admin-web:test-v1-linux-amd64",
  ]);
  const compose = JSON.parse(renderCompose("test-v1", "linux/amd64"));
  assert.equal(compose.services.api.image, "movie-harbor-api:test-v1-linux-amd64");
  assert.match(renderLoadScript("test-v1", "linux/amd64"), /linux\/amd64/);
  assert.match(renderBundleReadme("test-v1", "linux/amd64"), /linux\/amd64/);
});

function assertDeploymentMounts(compose) {
  for (const name of ["public-web", "admin-web"]) {
    assert.equal(Object.hasOwn(compose.services[name], "volumes"), false, `${name} must not mount host files`);
  }
  for (const [name, service] of Object.entries(compose.services)) {
    for (const volume of service.volumes ?? []) {
      if (typeof volume === "string") {
        assert.equal(name, "caddy", "only Caddy may use the configuration file mount");
        assert.equal(volume, "./Caddyfile:/etc/caddy/Caddyfile:ro");
        continue;
      }
      assert.equal(volume.source.includes("backend"), false);
      assert.equal(volume.source.includes("frontend"), false);
      assert.equal(volume.source.includes("src"), false);
      assert.equal(volume.source.includes("node_modules"), false);
      assert.equal(volume.source.includes("target"), false);
    }
  }
}

for (const service of ["public-web", "admin-web", "caddy"]) {
  test(`deployment mount assertions reject short source mounts on ${service}`, () => {
    const compose = JSON.parse(renderCompose(VERSION));
    compose.services[service].volumes ??= [];
    compose.services[service].volumes.push("./frontend:/app");
    assert.throws(() => assertDeploymentMounts(compose), assert.AssertionError);
  });
}

test("renders the same local configuration fallbacks in the offline Compose", () => {
  const environment = JSON.parse(renderCompose(VERSION)).services.api.environment;
  assert.deepEqual(
    {
      PUBLIC_ORIGIN: environment.PUBLIC_ORIGIN,
      COOKIE_SECURE: environment.COOKIE_SECURE,
      ALLOW_INSECURE_LAN_HTTP: environment.ALLOW_INSECURE_LAN_HTTP,
      MAX_UPLOAD_BYTES: environment.MAX_UPLOAD_BYTES,
    },
    {
      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
      COOKIE_SECURE: "${COOKIE_SECURE:-false}",
      ALLOW_INSECURE_LAN_HTTP: "${ALLOW_INSECURE_LAN_HTTP:-false}",
      MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
    },
  );
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
  }
  assertDeploymentMounts(compose);

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
      COOKIE_SECURE: "${COOKIE_SECURE:-false}",
      ALLOW_INSECURE_LAN_HTTP: "${ALLOW_INSECURE_LAN_HTTP:-false}",
      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
      TRUST_PROXY_HEADERS: "true",
      TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
      MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
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

test("bundle guidance explains HTTPS termination and matching origin and cookie settings", () => {
  const readme = renderBundleReadme(VERSION);

  assert.match(readme, /默认本机入口为 `http:\/\/localhost:8080`/);
  assert.match(readme, /修改 `APP_PORT`[^。\n]*localhost[^。\n]*必须同步[^。\n]*`PUBLIC_ORIGIN`[^。\n]*包含该端口[^。\n]*`http:\/\/localhost:9090`/);
  assert.doesNotMatch(readme, /默认入口为 `http:\/\/服务器地址:8080`/);
  assert.match(readme, /Caddy[^\n]*仅提供 HTTP/);
  assert.match(readme, /`PUBLIC_ORIGIN`[^\n]*实际访问[^\n]*`https:\/\/` 来源/);
  assert.match(readme, /`COOKIE_SECURE=true`[^\n]*外部 TLS 终止层/);
  assert.match(readme, /默认[^\n]*`ALLOW_INSECURE_LAN_HTTP=false`[^\n]*`http:\/\/localhost:8080\/admin\/`/);
  assert.match(readme, /可信局域网[^\n]*`PUBLIC_ORIGIN=http:\/\/localhost:8080`[^\n]*`COOKIE_SECURE=false`[^\n]*`ALLOW_INSECURE_LAN_HTTP=true`/);
  assert.match(readme, /`ALLOW_INSECURE_LAN_HTTP=true`[^。\n]*`docker compose up -d --no-build --wait`[^。\n]*重新创建容器/);
  assert.match(readme, /`docker compose restart`[^。\n]*不会更新容器环境变量/);
  assert.match(readme, /`http:\/\/192\.168\.1\.20:8080\/admin\/`/);
  assert.match(readme, /RFC1918[^\n]*ULA[^\n]*数字 IP[^\n]*不接受域名/);
  assert.match(readme, /localhost[^\n]*IP[^\n]*Cookie[^\n]*分别登录/);
  assert.match(readme, /域名[^\n]*公网[^\n]*不可信网络[^\n]*`ALLOW_INSECURE_LAN_HTTP=false`/);
  assert.match(readme, /不得[^\n]*公网[^\n]*不可信网络/);
});

test("bundle guidance explains initial administrator credentials and independent proxy secrets", () => {
  const readme = renderBundleReadme(VERSION);

  assert.match(readme, /尚无管理员[^\n]*ADMIN_NAME[^\n]*ADMIN_INITIAL_PASSWORD/);
  assert.match(readme, /不会覆盖已有管理员/);
  assert.match(readme, /首次登录[^\n]*修改密码[^\n]*移除初始凭据/);
  assert.match(readme, /每台部署[^\n]*TRUST_PROXY_SECRET[^\n]*至少 32 字节[^\n]*随机秘密/);
  assert.match(readme, /不要复用[^\n]*密码/);
  assert.match(readme, /\/admin\//);
});
