const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUPPORTED_PLATFORM = "linux/arm64";

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("invalid version: use only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}

export function normalizePlatform(os, architecture) {
  if (os !== "linux" || !["aarch64", "arm64"].includes(architecture)) {
    throw new Error(`only supports ${SUPPORTED_PLATFORM}`);
  }
  return SUPPORTED_PLATFORM;
}

export function imageTags(version) {
  const safeVersion = validateVersion(version);
  return [
    `movie-harbor-api:${safeVersion}-linux-arm64`,
    `movie-harbor-public-web:${safeVersion}-linux-arm64`,
    `movie-harbor-admin-web:${safeVersion}-linux-arm64`,
  ];
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

export function renderCompose(version) {
  const [apiImage, publicWebImage, adminWebImage] = imageTags(version);
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
          COOKIE_SECURE: "${COOKIE_SECURE:-true}",
          PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN}",
          TRUST_PROXY_HEADERS: "true",
          TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
          MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-5368709120}",
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

export function renderLoadScript(version) {
  const tags = imageTags(version);
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
  if [ "$platform" != "${SUPPORTED_PLATFORM}" ]; then
    echo "expected $image to use ${SUPPORTED_PLATFORM}, found $platform" >&2
    exit 1
  fi
done
`;
}

export function renderBundleReadme(version) {
  const tags = imageTags(version);
  return [
    "# Movie Harbor 半离线部署包",
    "",
    `此包为版本 \`${version}\`，只支持 \`${SUPPORTED_PLATFORM}\` 目标服务器。`,
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
    `需要 Docker Engine、Docker Compose v2 和 \`${SUPPORTED_PLATFORM}\`。解压后执行：`,
    "",
    "```sh",
    "./load-images.sh",
    "cp .env.example .env",
    "# 编辑 .env，设置密码、PUBLIC_ORIGIN 和宿主数据目录。",
    "docker compose up -d --no-build --wait",
    "```",
    "",
    "`DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 默认使用交付目录下的 `./data/`；升级前请同时备份数据库和媒体目录。停止服务使用 `docker compose down`，保留数据时不要添加 `--volumes`。",
    "",
  ].join("\n");
}
