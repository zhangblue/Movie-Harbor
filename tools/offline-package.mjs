import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,115}$/;
const DEFAULT_PLATFORM = "linux/arm64";
const PLATFORMS = new Map([
  ["linux/arm64", Object.freeze({ os: "linux", architecture: "arm64", slug: "linux-arm64" })],
  ["linux/amd64", Object.freeze({ os: "linux", architecture: "amd64", slug: "linux-amd64" })],
]);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE_DELIVERY_FILES = [
  ".env.example", "Caddyfile", "README.md", "compose.yml", "images.tar", "load-images.sh",
];
const USAGE = "Usage: ./tools/build-offline-package.sh [--platform <linux/arm64|linux/amd64>] [version]\nDefault platform: linux/arm64. Default version: Git short revision (12 characters). Output: dist/offline/";

function run(command, args, { cwd = REPO_ROOT, signal, capture = true } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    let failure;
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", error => { failure = error; });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
      if (failure) return;
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error(`${command} output exceeds metadata limit`);
        child.kill("SIGTERM");
      }
    });
    child.on("close", (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed (${childSignal ?? code})`));
      else resolveResult(output.trim());
    });
  });
}

function requireExactEntries(actual, expected, description) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${description} does not match the allowlist`);
  }
}

async function validateStaging(directory, files) {
  requireExactEntries(await readdir(directory), files, "staging");
  for (const file of files) {
    if (!(await lstat(join(directory, file))).isFile()) {
      throw new Error(`staging entry must be a regular file: ${file}`);
    }
  }
}

async function sha256(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const options = parseArguments(args);

  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = received => controller.abort(new Error(`Interrupted by ${received}`));
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let staging;
  let archiveDirectory;
  try {
    const version = validateVersion(options.version ?? await run("git", ["rev-parse", "--short=12", "HEAD"], { signal }));
    const tags = imageTags(version, options.platform);
    const deliveryFiles = deliveryFilesForPlatform(options.platform);
    const outputDirectory = join(REPO_ROOT, "dist/offline");
    const destination = join(outputDirectory, archiveName(version, options.platform));
    try {
      await lstat(destination);
      throw new Error(`Output already exists: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const daemonOs = await run("docker", ["info", "--format", "{{.OSType}}"], { signal });
    if (daemonOs !== "linux") {
      throw new Error(`Docker daemon must run Linux containers, found ${daemonOs || "unknown"}`);
    }
    await run("docker", ["compose", "version", "--short"], { signal });
    await run("docker", ["buildx", "version"], { signal });

    const dockerfiles = ["backend/Dockerfile", "frontend/public-web/Dockerfile", "frontend/admin-web/Dockerfile"];
    for (const [index, file] of dockerfiles.entries()) {
      await run("docker", [
        "buildx", "build", "--platform", options.platform, "--load",
        "--file", file, "--tag", tags[index], ".",
      ], { signal, capture: false });
    }
    for (const tag of tags) {
      const imagePlatform = await run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", tag], { signal });
      const components = imagePlatform.split("/");
      const normalized = components.length === 2
        ? normalizeImagePlatform(components[0], components[1])
        : imagePlatform;
      if (normalized !== options.platform) {
        throw new Error(`Expected ${tag} to use ${options.platform}, found ${imagePlatform}`);
      }
    }

    staging = await mkdtemp(join(tmpdir(), "movie-harbor-offline-"));
    const bundle = join(staging, "movie-harbor");
    await mkdir(bundle);
    for (const file of ["Caddyfile", ".env.example"]) await copyFile(join(REPO_ROOT, file), join(bundle, file));
    await writeFile(join(bundle, "compose.yml"), renderCompose(version, options.platform));
    await writeFile(join(bundle, "load-images.sh"), renderLoadScript(version, options.platform));
    await chmod(join(bundle, "load-images.sh"), 0o755);
    if (options.platform === "linux/amd64") {
      await writeFile(join(bundle, "load-images.ps1"), renderLoadPowerShell(version, options.platform));
    }
    await writeFile(join(bundle, "README.md"), renderBundleReadme(version, options.platform));
    await mkdir(outputDirectory, { recursive: true });
    await run("docker", ["image", "save", "--output", join(bundle, "images.tar"), ...tags], { signal, capture: false });
    await validateStaging(bundle, deliveryFiles);

    const manifest = JSON.parse(await run("tar", ["-xOf", join(bundle, "images.tar"), "manifest.json"], { signal }));
    if (!Array.isArray(manifest) || manifest.some(image => !Array.isArray(image?.RepoTags))) {
      throw new Error("images.tar manifest must contain RepoTags arrays");
    }
    requireExactEntries(manifest.flatMap(image => image.RepoTags), tags, "images.tar RepoTags");
    const checksums = [];
    for (const file of deliveryFiles) checksums.push(`${await sha256(join(bundle, file), signal)}  ${file}`);
    await writeFile(join(bundle, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    await validateStaging(bundle, [...deliveryFiles, "SHA256SUMS"]);

    // Keep the completed archive on the destination filesystem for atomic publication.
    archiveDirectory = await mkdtemp(join(outputDirectory, ".package-"));
    const archive = join(archiveDirectory, "bundle.tar.gz");
    await run("tar", ["-czf", archive, "-C", staging, "movie-harbor"], { signal, capture: false });
    const entries = (await run("tar", ["-tzf", archive], { signal })).split("\n");
    requireExactEntries(entries, ["movie-harbor/", ...deliveryFiles.map(file => `movie-harbor/${file}`), "movie-harbor/SHA256SUMS"], "archive entries");
    signal.throwIfAborted();
    // link atomically creates the final name and fails with EEXIST, including races.
    await link(archive, destination);
    console.log(`Created ${destination}`);
  } finally {
    const cleanup = await Promise.allSettled([staging, archiveDirectory].filter(Boolean).map(directory => rm(directory, { recursive: true, force: true })));
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("invalid version: use only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}

export function platformInfo(value) {
  const info = PLATFORMS.get(value);
  if (!info) throw new Error(`unsupported platform: ${value}`);
  return info;
}

export function parseArguments(args) {
  if (args[0] === "--platform") {
    if (args.length < 2 || args.length > 3 || args[2]?.startsWith("-")) {
      throw new Error(USAGE);
    }
    platformInfo(args[1]);
    return { platform: args[1], version: args[2] };
  }
  if (args.length > 1 || args[0]?.startsWith("-")) throw new Error(USAGE);
  return { platform: DEFAULT_PLATFORM, version: args[0] };
}

export function normalizeImagePlatform(os, architecture) {
  if (os === "linux" && ["aarch64", "arm64"].includes(architecture)) return "linux/arm64";
  if (os === "linux" && ["x86_64", "amd64"].includes(architecture)) return "linux/amd64";
  throw new Error(`unsupported image platform: ${os}/${architecture}`);
}

export function imageTags(version, platform = DEFAULT_PLATFORM) {
  const safeVersion = validateVersion(version);
  const { slug } = platformInfo(platform);
  return [
    `movie-harbor-api:${safeVersion}-${slug}`,
    `movie-harbor-public-web:${safeVersion}-${slug}`,
    `movie-harbor-admin-web:${safeVersion}-${slug}`,
  ];
}

export function archiveName(version, platform = DEFAULT_PLATFORM) {
  const safeVersion = validateVersion(version);
  const { slug } = platformInfo(platform);
  return `movie-harbor-offline-${slug}-${safeVersion}.tar.gz`;
}

function deliveryFilesForPlatform(platform) {
  platformInfo(platform);
  return platform === "linux/amd64"
    ? [...BASE_DELIVERY_FILES, "load-images.ps1"]
    : [...BASE_DELIVERY_FILES];
}

function bind(source, target, options = {}) {
  return {
    type: "bind",
    source,
    target,
    ...options,
    bind: { create_host_path: true },
  };
}

function healthcheck(test, retries, startPeriod) {
  return {
    test,
    interval: "5s",
    timeout: "5s",
    retries,
    ...(startPeriod ? { start_period: startPeriod } : {}),
  };
}

export function renderCompose(version, platform = DEFAULT_PLATFORM) {
  const [apiImage, publicWebImage, adminWebImage] = imageTags(version, platform);
  const mediaSource = "${MEDIA_HOST_DIR:-./data/media}";

  return `${JSON.stringify({
    name: "movie-harbor",
    services: {
      postgres: {
        image: "postgres:17-alpine",
        restart: "unless-stopped",
        environment: {
          POSTGRES_DB: "${POSTGRES_DB:?set POSTGRES_DB}",
          POSTGRES_USER: "${POSTGRES_USER:?set POSTGRES_USER}",
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}",
        },
        volumes: [bind("${DATABASE_HOST_DIR:-./data/postgres}", "/var/lib/postgresql/data")],
        healthcheck: healthcheck(
          ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"],
          20,
          "10s",
        ),
      },
      "media-init": {
        image: "alpine:3.22",
        restart: "no",
        command: ["sh", "-c", "chown 10001:10001 /media && chmod 0700 /media"],
        volumes: [bind(mediaSource, "/media")],
      },
      api: {
        image: apiImage,
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
          PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
          TRUST_PROXY_HEADERS: "true",
          TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
          MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
          VIDEO_MIME_ALLOWLIST: "${VIDEO_MIME_ALLOWLIST:-video/mp4,video/webm}",
          ADMIN_NAME: "${ADMIN_NAME:-}",
          ADMIN_INITIAL_PASSWORD: "${ADMIN_INITIAL_PASSWORD:-}",
        },
        volumes: [bind(mediaSource, "/media")],
        healthcheck: healthcheck(
          ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:3000/api/health"],
          20,
          "10s",
        ),
      },
      "public-web": {
        image: publicWebImage,
        pull_policy: "never",
        restart: "unless-stopped",
        healthcheck: healthcheck(
          ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/"],
          10,
        ),
      },
      "admin-web": {
        image: adminWebImage,
        pull_policy: "never",
        restart: "unless-stopped",
        healthcheck: healthcheck(
          ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/admin/"],
          10,
        ),
      },
      caddy: {
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
          bind(mediaSource, "/srv/media", { read_only: true }),
        ],
        healthcheck: healthcheck(
          ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1/api/health"],
          10,
        ),
      },
    },
  }, null, 2)}\n`;
}

export function renderLoadScript(version, platform = DEFAULT_PLATFORM) {
  const tags = imageTags(version, platform);
  const { os, architecture } = platformInfo(platform);
  const imagePlatform = `${os}/${architecture}`;
  const quotedTags = tags.map((tag) => `  '${tag}'`).join(" \\\n");

  return `#!/bin/sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sha256sum -c SHA256SUMS
docker image load -i images.tar

for image in \\
${quotedTags}
do
  platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  if [ "$platform" != "${imagePlatform}" ]; then
    echo "expected $image to use ${imagePlatform}, found $platform" >&2
    exit 1
  fi
done
`;
}

export function renderLoadPowerShell(version, platform = "linux/amd64") {
  platformInfo(platform);
  if (platform !== "linux/amd64") {
    throw new Error("PowerShell image loading is only supported for linux/amd64 packages");
  }
  const files = deliveryFilesForPlatform(platform);
  const tags = imageTags(version, platform);
  const expectedFiles = files.map(file => `    '${file}'`).join(",\n");
  const expectedImages = tags.map(tag => `    '${tag}'`).join(",\n");

  return `$ErrorActionPreference = 'Stop'

try {
    $packageRoot = $PSScriptRoot
    $manifestPath = Join-Path -Path $packageRoot -ChildPath 'SHA256SUMS'
    $expectedFiles = @(
${expectedFiles}
    )
    $expected = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::Ordinal)
    foreach ($name in $expectedFiles) {
        $expected.Add($name, $true)
    }

    $entries = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    $seen = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::Ordinal)
    foreach ($line in @(Get-Content -LiteralPath $manifestPath)) {
        $match = [regex]::Match($line, '^(?i:[0-9a-f]{64})  (?<name>[^/\\\\]+)$')
        if (-not $match.Success) {
            throw 'invalid SHA256SUMS entry'
        }
        $name = $match.Groups['name'].Value
        if (-not $expected.ContainsKey($name)) {
            throw "unexpected checksum entry: $name"
        }
        if ($seen.ContainsKey($name)) {
            throw "duplicate checksum entry: $name"
        }
        $seen.Add($name, $true)
        $entries.Add($name, $match.Groups['hash'].Value.ToLowerInvariant())
    }
    if ($entries.Count -ne $expectedFiles.Count) {
        throw 'SHA256SUMS does not exactly cover the package allowlist'
    }

    foreach ($name in $expectedFiles) {
        if (-not $entries.ContainsKey($name)) {
            throw "missing checksum entry: $name"
        }
        $path = Join-Path -Path $packageRoot -ChildPath $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "missing package file: $name"
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $entries[$name]) {
            throw "checksum mismatch: $name"
        }
    }

    $imagesPath = Join-Path -Path $packageRoot -ChildPath 'images.tar'
    docker image load --input $imagesPath
    if ($LASTEXITCODE -ne 0) {
        throw 'docker image load failed'
    }

    $images = @(
${expectedImages}
    )
    foreach ($image in $images) {
        $imagePlatform = docker image inspect --format '{{.Os}}/{{.Architecture}}' $image
        if ($LASTEXITCODE -ne 0 -or $imagePlatform.Trim() -ne 'linux/amd64') {
            throw "expected $image to use linux/amd64"
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
}

export function renderBundleReadme(version, platform = DEFAULT_PLATFORM) {
  const tags = imageTags(version, platform);
  const { os, architecture } = platformInfo(platform);
  const imagePlatform = `${os}/${architecture}`;
  return [
    "# Movie Harbor 半离线部署包",
    "",
    `此包为版本 \`${version}\`，只支持 \`${imagePlatform}\` 目标服务器。`,
    "",
    "## 联网要求",
    "",
    "包内仅有 Movie Harbor 自研镜像：",
    "",
    ...tags.map((tag) => `- \`${tag}\``),
    "",
    "目标服务器仍须联网访问 Docker Hub 下载官方镜像：",
    "",
    "- `postgres:17-alpine`",
    "- `alpine:3.22`",
    "- `caddy:2.10-alpine`",
    "",
    "因此此包不能用于完全断网部署。",
    "",
    "## 部署",
    "",
    `需要 Docker Engine、Docker Compose v2 和 \`${imagePlatform}\`。解压后执行：`,
    "",
    "```sh",
    "./load-images.sh",
    "cp .env.example .env",
    "# 按下方配置说明编辑 .env 后再启动。",
    "docker compose up -d --no-build --wait",
    "```",
    "",
    "## 首次配置与访问",
    "",
    "包内 Caddy 仅提供 HTTP，默认本机入口为 `http://localhost:8080`，宿主端口可用 `APP_PORT` 修改。修改 `APP_PORT` 时，即使仍通过 localhost 访问，也必须同步将 `PUBLIC_ORIGIN` 改为包含该端口的实际来源，例如 `http://localhost:9090`。此 HTTP 默认仅适用于 localhost 或环回地址的本机访问。",
    "",
    "通过其他机器、域名、局域网地址或公网地址访问时，必须把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 `https://` 来源（协议、主机名和非默认端口，不含路径），设置 `COOKIE_SECURE=true`，并由外部 TLS 终止层把请求转发到包内 Caddy。本机 HTTP 默认显式使用 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`；不要通过公网或局域网明文 HTTP 提供管理后台。",
    "",
    "首次启动前替换 `POSTGRES_PASSWORD` 和初始管理员密码。API 自动执行数据库迁移；仅当数据库尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号。后续修改环境变量或重启不会覆盖已有管理员名称和密码。访问实际来源下的 `/admin/` 登录；首次登录并修改密码后，从 `.env` 移除初始凭据，保留其余必填变量。",
    "",
    "每台部署都必须把 `TRUST_PROXY_SECRET` 替换为独立的、至少 32 字节的高强度随机秘密，不要复用数据库或管理员密码，也不要跨部署复用。Compose 会把同一秘密传给 Caddy 和 API，用于认证受信代理；API 应仅由受信代理访问。",
    "",
    "`DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 默认使用交付目录下的 `./data/`；升级前请同时备份数据库和媒体目录。停止服务使用 `docker compose down`，保留数据时不要添加 `--volumes`。",
    "",
  ].join("\n");
}
