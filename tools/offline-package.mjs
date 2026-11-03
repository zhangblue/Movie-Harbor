import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,115}$/;
const DEFAULT_PLATFORM = "linux/arm64";
const ARM64_RUST_TARGET = "aarch64-unknown-linux-musl";
const SUPPORTED_PLATFORMS = new Set([DEFAULT_PLATFORM, "linux/amd64"]);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DELIVERY_FILES = [
  ".env.example", "Caddyfile", "README.md", "compose.yml", "images.tar", "load-images.sh",
];
const USAGE = "Usage: ./tools/build-offline-package.sh [--platform linux/arm64|linux/amd64] [version]\nDefault version: Git short revision (12 characters). Output: dist/offline/";

// 解析离线包命令参数，供构建前验证目标平台和版本。
function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  let platform = DEFAULT_PLATFORM;
  let remaining = args;
  if (args[0] === "--platform") {
    if (args.length < 2 || args[1].startsWith("-")) throw new Error(USAGE);
    try {
      platform = normalizePlatform(args[1]);
    } catch (error) {
      throw new Error(`${error.message}\n${USAGE}`);
    }
    remaining = args.slice(2);
  }
  if (remaining.length > 1 || remaining[0]?.startsWith("-")) throw new Error(USAGE);
  return { platform, version: remaining[0] };
}

// 向构建子进程组发送信号，供取消时同时终止后代进程。
function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// 等待进程组退出，供取消构建时确定后续清理时机。
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (signalProcessGroup(pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    // 轮询进程组退出时短暂让出事件循环，并遵守剩余等待期限。
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

// 终止并等待进程组，避免构建失败后留下后台进程。
async function finishProcessGroup(pid) {
  if (await waitForProcessGroupExit(pid, 1000)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, 1000))) {
    throw new Error(`Compiler process group ${pid} did not exit after SIGKILL`);
  }
}

// 启动构建外部命令并处理输出、取消和进程组生命周期。
function run(command, args, { cwd = REPO_ROOT, signal, capture = true, processGroup = false, env = {} } = {}) {
  signal?.throwIfAborted();
  // 等待外部命令完成及进程组清理，供打包步骤依序执行。
  return new Promise((resolveResult, reject) => {
    // 直接启动构建命令并按需隔离进程组，取消时可终止其后代。
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
      ...(processGroup ? { detached: true } : {}),
    });
    let output = "";
    let failure;
    let groupTermination;
    // 取消后复用同一个进程组退出等待任务，避免重复清理。
    const waitForGroup = () => {
      groupTermination ??= finishProcessGroup(child.pid);
      return groupTermination;
    };
    // 中断构建子进程及其后代，供取消信号触发。
    const abort = () => {
      if (!processGroup || !child.pid) return child.kill("SIGTERM");
      // Host compilers spawn linkers and other descendants in this POSIX process group.
      try {
        signalProcessGroup(child.pid, "SIGTERM");
        // Start the deadline now even if the wrapper itself ignores SIGTERM.
        // 等待后代进程失败时记录错误并强制终止包装进程。
        waitForGroup().catch(error => {
          failure = error;
          child.kill("SIGKILL");
        });
      } catch (error) {
        failure = error;
        child.kill("SIGKILL");
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    // 记录启动错误，随后由关闭回调统一返回。
    child.on("error", error => { failure = error; });
    child.stdout?.setEncoding("utf8");
    // 捕获受限大小的工具输出；超限时终止命令。
    child.stdout?.on("data", chunk => {
      if (failure) return;
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error(`${command} output exceeds metadata limit`);
        child.kill("SIGTERM");
      }
    });
    // 命令关闭后再检查进程组和取消状态，避免残留后代。
    child.on("close", (code, childSignal) => {
      // 子进程结束后汇总输出与清理结果，再结算构建命令。
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed (${childSignal ?? code})`));
        else resolveResult(output.trim());
      };
      if (!processGroup || !child.pid) return finish();
      // A compiler wrapper may exit before descendants finish handling SIGTERM.
      // 等待编译器后代退出后再结算，清理失败则拒绝本次构建。
      waitForGroup().then(() => {
        if (failure) {
          signal?.removeEventListener("abort", abort);
          reject(failure);
        } else finish();
      // 进程组收尾失败时移除取消监听并拒绝，避免误报构建成功。
      }, error => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  });
}

// 校验工具版本输出，供构建依赖预检使用。
function requireVersion(output, tool) {
  const version = output.trim();
  if (!version) throw new Error(`${tool} returned empty version output`);
  console.log(`${tool}: ${version}`);
  return version;
}

// 从 PATH 查找可执行命令，供构建环境预检使用。
function resolvePathCommand(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", command);
    try {
      const resolved = realpathSync(candidate);
      if (!lstatSync(resolved).isFile()) continue;
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (!new Set(["EACCES", "ENOENT", "ENOTDIR"]).has(error.code)) throw error;
    }
  }
  throw new Error(`${command} is missing from PATH`);
}

// 校验 ARM64 API 可执行文件元数据，避免打包错误架构。
function validateArm64BinaryMetadata(output) {
  if (!/ELF 64-bit/i.test(output)) throw new Error(`Expected a Linux ELF binary, found: ${output}`);
  if (!/(ARM aarch64|AArch64|aarch64)/i.test(output)) {
    throw new Error(`Expected an ARM64/aarch64 binary, found: ${output}`);
  }
  if (/dynamically linked/i.test(output) || !/(statically linked|static-pie linked)/i.test(output)) {
    throw new Error(`Expected a statically linked musl binary, found: ${output}`);
  }
}

// 为 ARM64 镜像准备并检查 API 构建上下文，失败时清理临时资源。
async function prepareArm64ApiContext(signal) {
  requireVersion(
    await run("rustc", ["--version"], { signal }),
    "Rust",
  );
  requireVersion(
    await run("cargo-zigbuild", ["--version"], { signal }),
    "cargo-zigbuild",
  );
  const zigCommand = resolvePathCommand("zig");
  const zigVersion = requireVersion(
    await run(zigCommand, ["version"], { signal }),
    "Zig",
  );
  const targets = (await run("rustup", ["target", "list", "--installed"], { signal })).split("\n");
  if (!targets.includes(ARM64_RUST_TARGET)) {
    throw new Error(`Required ${ARM64_RUST_TARGET} Rust target is missing`);
  }

  const targetDirectory = await mkdtemp(join(tmpdir(), "movie-harbor-arm64-target-"));
  let contextDirectory;
  try {
    contextDirectory = await mkdtemp(join(tmpdir(), "movie-harbor-api-arm64-"));
    await run("cargo", [
      "zigbuild", "--locked", "--release", "--target", ARM64_RUST_TARGET,
      "--target-dir", targetDirectory, "-p", "movie-harbor-api",
    ], {
      signal,
      capture: false,
      processGroup: true,
      env: {
        CARGO_ZIGBUILD_ZIG_COMMAND: zigCommand,
        CARGO_ZIGBUILD_ZIG_COMMAND_ARGS: "",
        CARGO_ZIGBUILD_ZIG_VERSION: zigVersion,
      },
    });
    const binary = join(targetDirectory, ARM64_RUST_TARGET, "release", "movie-harbor-api");
    let binaryStat;
    try {
      binaryStat = await lstat(binary);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`movie-harbor-api binary is missing: ${binary}`);
      throw error;
    }
    if (!binaryStat.isFile()) throw new Error(`movie-harbor-api must be a regular file: ${binary}`);
    const metadata = await run("file", [binary], { signal });
    // The target name in the filename must not count as evidence of the ELF architecture.
    const description = metadata.startsWith(`${binary}: `) ? metadata.slice(binary.length + 2) : metadata;
    validateArm64BinaryMetadata(description);
    const destination = join(contextDirectory, "movie-harbor-api");
    await copyFile(binary, destination);
    await chmod(destination, 0o755);
    return { targetDirectory, contextDirectory };
  } catch (error) {
    await Promise.allSettled([
      rm(targetDirectory, { recursive: true, force: true }),
      ...(contextDirectory ? [rm(contextDirectory, { recursive: true, force: true })] : []),
    ]);
    throw error;
  }
}

// 核对打包目录条目与预期完全一致，防止遗漏或意外包含文件。
function requireExactEntries(actual, expected, description) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${description} does not match the allowlist`);
  }
}

// 归档前检查暂存内容和文件类型，避免发布不完整或多余文件。
async function validateStaging(directory, files) {
  requireExactEntries(await readdir(directory), files, "staging");
  for (const file of files) {
    if (!(await lstat(join(directory, file))).isFile()) {
      throw new Error(`staging entry must be a regular file: ${file}`);
    }
  }
}

// 计算归档摘要，供生成与校验发布文件使用。
async function sha256(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

// 协调依赖预检、镜像构建、暂存、归档和校验文件生成。
async function main(args) {
  const parsed = parseArguments(args);
  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;
  // 将系统信号转换为取消原因，供打包阶段停止。
  const interrupt = received => controller.abort(new Error(`Interrupted by ${received}`));
  // 收到 SIGINT 时取消当前打包。
  const onInt = () => interrupt("SIGINT");
  // 收到 SIGTERM 时取消当前打包。
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let staging;
  let archiveDirectory;
  let arm64Build;
  try {
    const { platform } = parsed;
    const version = validateVersion(parsed.version ?? await run("git", ["rev-parse", "--short=12", "HEAD"], { signal }));
    const tags = imageTags(version, platform);
    const outputDirectory = join(REPO_ROOT, "dist/offline");
    const destination = join(outputDirectory, `movie-harbor-offline-${platformSuffix(platform)}-${version}.tar.gz`);
    try {
      await lstat(destination);
      throw new Error(`Output already exists: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await run("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"], { signal });
    await run("docker", ["buildx", "version"], { signal });
    await run("docker", ["compose", "version", "--short"], { signal });

    if (platform === "linux/arm64") {
      arm64Build = await prepareArm64ApiContext(signal);
      await run("docker", [
        "buildx", "build", "--load", "--platform", platform,
        "--file", "backend/Dockerfile.prebuilt", "--tag", tags[0], arm64Build.contextDirectory,
      ], { signal, capture: false });
    } else {
      await run("docker", [
        "buildx", "build", "--load", "--platform", platform,
        "--file", "backend/Dockerfile", "--tag", tags[0], ".",
      ], { signal, capture: false });
    }
    for (const [file, tag] of [
      ["frontend/public-web/Dockerfile", tags[1]],
      ["frontend/admin-web/Dockerfile", tags[2]],
    ]) {
      await run("docker", [
        "buildx", "build", "--load", "--platform", platform,
        "--file", file, "--tag", tag, ".",
      ], { signal, capture: false });
    }
    for (const tag of tags) {
      const imagePlatform = await run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", tag], { signal });
      if (imagePlatform !== platform) throw new Error(`Expected ${tag} to use ${platform}, found ${imagePlatform}`);
    }

    // 先在临时目录组装交付清单，避免未完成内容出现在最终发布路径。
    staging = await mkdtemp(join(tmpdir(), "movie-harbor-offline-"));
    const bundle = join(staging, "movie-harbor");
    await mkdir(bundle);
    for (const file of ["Caddyfile", ".env.example"]) await copyFile(join(REPO_ROOT, file), join(bundle, file));
    await writeFile(join(bundle, "compose.yml"), renderCompose(version, platform));
    await writeFile(join(bundle, "load-images.sh"), renderLoadScript(version, platform));
    await chmod(join(bundle, "load-images.sh"), 0o755);
    await writeFile(join(bundle, "README.md"), renderBundleReadme(version, platform));
    await mkdir(outputDirectory, { recursive: true });
    await run("docker", ["image", "save", "--output", join(bundle, "images.tar"), ...tags], { signal, capture: false });
    await validateStaging(bundle, DELIVERY_FILES);

    // 导出后核对镜像标签和文件清单，并写入校验和，防止错误或多余镜像进入归档。
    const manifest = JSON.parse(await run("tar", ["-xOf", join(bundle, "images.tar"), "manifest.json"], { signal }));
    if (!Array.isArray(manifest) || manifest.some(image => !Array.isArray(image?.RepoTags))) {
      throw new Error("images.tar manifest must contain RepoTags arrays");
    }
    requireExactEntries(manifest.flatMap(image => image.RepoTags), tags, "images.tar RepoTags");
    const checksums = [];
    for (const file of DELIVERY_FILES) checksums.push(`${await sha256(join(bundle, file), signal)}  ${file}`);
    await writeFile(join(bundle, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    await validateStaging(bundle, [...DELIVERY_FILES, "SHA256SUMS"]);

    // Keep the completed archive on the destination filesystem for atomic publication.
    // 在目标文件系统生成归档并核对条目，确保发布前内容完整且可原子链接。
    archiveDirectory = await mkdtemp(join(outputDirectory, ".package-"));
    const archive = join(archiveDirectory, "bundle.tar.gz");
    await run("tar", ["-czf", archive, "-C", staging, "movie-harbor"], { signal, capture: false });
    const entries = (await run("tar", ["-tzf", archive], { signal })).split("\n");
    requireExactEntries(entries, ["movie-harbor/", ...DELIVERY_FILES.map(file => `movie-harbor/${file}`), "movie-harbor/SHA256SUMS"], "archive entries");
    signal.throwIfAborted();
    // link atomically creates the final name and fails with EEXIST, including races.
    // 以硬链接原子创建最终名称；并发出现同名产物时失败而不覆盖。
    await link(archive, destination);
    console.log(`Created ${destination}`);
  } finally {
    const cleanup = await Promise.allSettled([
      staging, archiveDirectory, arm64Build?.targetDirectory, arm64Build?.contextDirectory,
    // 构建结束时并行清除本次临时目录；任一清理失败会继续报告。
    ].filter(Boolean).map(directory => rm(directory, { recursive: true, force: true })));
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CLI 顶层报告构建失败并设置退出码，供调用脚本识别。
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

// 验证版本标签可安全用于镜像和文件名，供参数解析及渲染使用。
export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("invalid version: use only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}

// 规范化并校验目标平台，供镜像标签及打包配置使用。
export function normalizePlatform(value = DEFAULT_PLATFORM) {
  if (!SUPPORTED_PLATFORMS.has(value)) {
    throw new Error("supported platforms are linux/arm64 and linux/amd64");
  }
  return value;
}

// 生成平台对应的文件名后缀，供区分单架构归档使用。
function platformSuffix(platform) {
  return normalizePlatform(platform).replace("/", "-");
}

// 为指定版本和平台生成自研镜像标签，供构建及加载脚本使用。
export function imageTags(version, platform = DEFAULT_PLATFORM) {
  const safeVersion = validateVersion(version);
  const suffix = platformSuffix(platform);
  return ["api", "public-web", "admin-web"]
    .map(name => `movie-harbor-${name}:${safeVersion}-${suffix}`);
}

// 生成 Compose bind mount 配置，供渲染发布包部署文件使用。
function bind(source, target, options = {}) {
  return {
    type: "bind",
    source,
    target,
    ...options,
    bind: { create_host_path: true },
  };
}

// 生成 Compose 健康检查配置，供部署时等待依赖就绪。
function healthcheck(test, retries, startPeriod) {
  return {
    test,
    interval: "5s",
    timeout: "5s",
    retries,
    ...(startPeriod ? { start_period: startPeriod } : {}),
  };
}

// 渲染指定版本和平台的部署配置，供离线包生成使用。
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
          ALLOW_INSECURE_LAN_HTTP: "${ALLOW_INSECURE_LAN_HTTP:-false}",
          PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
          TRUST_PROXY_HEADERS: "true",
          TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
          MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
          VIDEO_MIME_ALLOWLIST: "${VIDEO_MIME_ALLOWLIST:-video/mp4,video/webm}",
          MCP_API_KEY_SHA256: "${MCP_API_KEY_SHA256:-}",
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

// 渲染目标机镜像加载脚本，供离线包部署时使用。
export function renderLoadScript(version, platform = DEFAULT_PLATFORM) {
  const tags = imageTags(version, platform);
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
  if [ "$platform" != "${normalizePlatform(platform)}" ]; then
    echo "expected $image to use ${platform}, found $platform" >&2
    exit 1
  fi
done
`;
}

// 渲染发布包部署说明，供目标机安装和升级时参考。
export function renderBundleReadme(version, platform = DEFAULT_PLATFORM) {
  const tags = imageTags(version, platform);
  return [
    "# Movie Harbor 半离线部署包",
    "",
    `此包为版本 \`${version}\`，只支持 \`${platform}\` 目标服务器。`,
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
    `需要 Docker Engine、Docker Compose v2 和 \`${platform}\`。解压后执行：`,
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
    "包内 Caddy 仅提供 HTTP，默认本机入口为 `http://localhost:8080`，宿主端口可用 `APP_PORT` 修改。修改 `APP_PORT` 时，即使仍通过 localhost 访问，也必须同步将 `PUBLIC_ORIGIN` 改为包含该端口的实际来源，例如 `http://localhost:9090`。",
    "",
    "默认 `ALLOW_INSECURE_LAN_HTTP=false`：仅从 `http://localhost:8080/admin/` 或规范环回来源访问，才能完整使用管理后台。",
    "",
    "可信局域网：保持 `PUBLIC_ORIGIN=http://localhost:8080`、`COOKIE_SECURE=false`，设置 `ALLOW_INSECURE_LAN_HTTP=true` 后，在交付目录执行 `docker compose up -d --no-build --wait` 重新创建容器；单独执行 `docker compose restart` 不会更新容器环境变量。然后通过服务器私有数字 IP 访问，例如 `http://192.168.1.20:8080/admin/`。只接受 RFC1918/ULA 范围的数字 IP，不接受域名。localhost 与 IP 的 Cookie 彼此隔离，需要分别登录。自定义 `APP_PORT` 时同步修改 `PUBLIC_ORIGIN` 的端口。",
    "",
    "域名、公网或不可信网络：把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 `https://` 来源（协议、主机名和非默认端口，不含路径），设置 `COOKIE_SECURE=true` 和 `ALLOW_INSECURE_LAN_HTTP=false`，并由外部 TLS 终止层或 VPN 提供加密访问。不得在公网或不可信网络启用局域网明文 HTTP 开关；该开关不能替代传输加密。",
    "",
    "首次启动前替换 `POSTGRES_PASSWORD` 和初始管理员密码。API 自动执行数据库迁移；仅当数据库尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号。后续修改环境变量或重启不会覆盖已有管理员名称和密码。访问实际来源下的 `/admin/` 登录；首次登录并修改密码后，从 `.env` 移除初始凭据，保留其余必填变量。",
    "",
    "每台部署都必须把 `TRUST_PROXY_SECRET` 替换为独立的、至少 32 字节的高强度随机秘密，不要复用数据库或管理员密码，也不要跨部署复用。Compose 会把同一秘密传给 Caddy 和 API，用于认证受信代理；API 应仅由受信代理访问。",
    "",
    "`DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 默认使用交付目录下的 `./data/`；升级前请同时备份数据库和媒体目录。停止服务使用 `docker compose down`，保留数据时不要添加 `--volumes`。",
    "",
  ].join("\n");
}
