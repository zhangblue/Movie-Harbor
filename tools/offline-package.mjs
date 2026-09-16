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
  "start.sh", "storage-compose.mjs", "upgrade-media-storage.mjs", "upgrade-media-storage.sh",
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
    for (const file of ["storage-compose.mjs", "upgrade-media-storage.mjs", "upgrade-media-storage.sh"]) {
      await copyFile(join(REPO_ROOT, "tools", file), join(bundle, file));
    }
    await chmod(join(bundle, "upgrade-media-storage.sh"), 0o755);
    await writeFile(join(bundle, "compose.yml"), renderCompose(version, options.platform));
    await writeFile(join(bundle, "load-images.sh"), renderLoadScript(version, options.platform));
    await chmod(join(bundle, "load-images.sh"), 0o755);
    await writeFile(join(bundle, "start.sh"), renderStartScript(version, options.platform));
    await chmod(join(bundle, "start.sh"), 0o755);
    if (options.platform === "linux/amd64") {
      await writeFile(join(bundle, "load-images.ps1"), renderLoadPowerShell(version, options.platform));
      await writeFile(join(bundle, "start.ps1"), renderStartPowerShell(version, options.platform));
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
    ? [...BASE_DELIVERY_FILES, "load-images.ps1", "start.ps1"]
    : [...BASE_DELIVERY_FILES];
}

function bind(source, target, { create_host_path = true, ...options } = {}) {
  return {
    type: "bind",
    source,
    target,
    ...options,
    bind: { create_host_path },
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
        command: ["sh", "-c", "for directory in /media/volumes/*; do chown 10001:10001 \"$$directory\" && chmod 0711 \"$$directory\"; done"],
        volumes: [bind(mediaSource, "/media/volumes/0", { create_host_path: false })],
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
          MEDIA_DIRS: "/media/volumes/0",
          MEDIA_DISK_RESERVE_BYTES: "${MEDIA_DISK_RESERVE_BYTES:-10737418240}",
          COOKIE_SECURE: "${COOKIE_SECURE:-false}",
          PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
          TRUST_PROXY_HEADERS: "true",
          TRUST_PROXY_SECRET: "${TRUST_PROXY_SECRET:?set TRUST_PROXY_SECRET}",
          MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
          VIDEO_MIME_ALLOWLIST: "${VIDEO_MIME_ALLOWLIST:-video/mp4,video/webm}",
          ADMIN_NAME: "${ADMIN_NAME:-}",
          ADMIN_INITIAL_PASSWORD: "${ADMIN_INITIAL_PASSWORD:-}",
        },
        volumes: [bind(mediaSource, "/media/volumes/0", { create_host_path: false })],
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
          bind(mediaSource, "/srv/media/volumes/0", { read_only: true, create_host_path: false }),
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
        $match = [regex]::Match($line, '^(?<hash>(?i:[0-9a-f]{64}))  (?<name>[^/\\\\]+)$')
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

export function renderStartPowerShell(version, platform = "linux/amd64") {
  validateVersion(version);
  platformInfo(platform);
  if (platform !== "linux/amd64") {
    throw new Error("PowerShell deployment is only supported for linux/amd64 packages");
  }

  return String.raw`$ErrorActionPreference = 'Stop'

function Test-ExactProperties($Value, [string[]]$ExpectedNames) {
    $remaining = [System.Collections.Generic.HashSet[string]]::new(
        $ExpectedNames,
        [System.StringComparer]::Ordinal
    )
    foreach ($property in @($Value.PSObject.Properties)) {
        if (-not $remaining.Remove($property.Name)) {
            return $false
        }
    }
    return $remaining.Count -eq 0
}

function Write-Utf8NoBomAtomic([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    $temporary = Join-Path -Path $parent -ChildPath ('.{0}.{1}.{2}.tmp' -f $leaf, $PID, [Guid]::NewGuid().ToString('N'))
    try {
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($temporary, $Content, $utf8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Get-FirstDotenvValue([string]$EnvPath, [string]$Name) {
    $rawValue = $null
    $escapedName = [regex]::Escape($Name)
    foreach ($line in [System.IO.File]::ReadAllLines($EnvPath)) {
        $match = [regex]::Match($line, ('^\s*{0}\s*=(?<value>.*)$' -f $escapedName))
        if ($match.Success) {
            $rawValue = $match.Groups['value'].Value.Trim()
            break
        }
    }
    if ($null -eq $rawValue) {
        throw "$Name is missing from .env"
    }
    if ($rawValue.StartsWith('"') -or $rawValue.EndsWith('"')) {
        if ($rawValue.Length -lt 2 -or -not ($rawValue.StartsWith('"') -and $rawValue.EndsWith('"'))) {
            throw "$Name has unmatched double quotes"
        }
        $rawValue = $rawValue.Substring(1, $rawValue.Length - 2)
    }
    if ($rawValue.Contains('"')) {
        throw "$Name only accepts an unquoted value or one pair of double quotes"
    }
    return $rawValue
}

function Get-DatabaseHostDirectory([string]$EnvPath) {
    $entry = Get-FirstDotenvValue $EnvPath 'DATABASE_HOST_DIR'
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($entry)) {
        throw 'database directory cannot contain wildcard characters'
    }
    if ($entry.StartsWith('\\') -or $entry.StartsWith('//')) {
        throw 'database directory cannot use UNC network paths'
    }
    if ($entry -notmatch '^[A-Za-z]:[\\/]') {
        throw 'database directory must be an absolute Windows drive path'
    }
    $driveName = $entry.Substring(0, 1)
    if ($null -eq (Get-PSDrive -Name $driveName -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
        throw "database drive does not exist: $driveName"
    }
    $fullPath = [System.IO.Path]::GetFullPath($entry)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    while ($fullPath.Length -gt $root.Length -and ($fullPath.EndsWith('\') -or $fullPath.EndsWith('/'))) {
        $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw 'database directory does not exist'
    }
    $item = Get-Item -LiteralPath $fullPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'database directory cannot be a reparse point'
    }
    $probe = Join-Path -Path $item.FullName -ChildPath ('.movie-harbor-database-write-probe-{0}' -f [Guid]::NewGuid().ToString('N'))
    try {
        $stream = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Dispose()
    } catch {
        throw 'database directory is not writable'
    } finally {
        if (Test-Path -LiteralPath $probe) {
            Remove-Item -LiteralPath $probe -Force
        }
    }
    return ([System.IO.Path]::GetFullPath($item.FullName)).Replace('\', '/')
}

function Get-MediaHostDirectories([string]$EnvPath) {
    $rawValue = Get-FirstDotenvValue $EnvPath 'MEDIA_HOST_DIR'
    $entries = @($rawValue.Split([char]';') | ForEach-Object { $_.Trim() })
    if ($entries.Count -eq 0 -or @($entries | Where-Object { $_ -eq '' }).Count -ne 0) {
        throw 'MEDIA_HOST_DIR contains an empty directory entry'
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $directories = New-Object System.Collections.ArrayList
    foreach ($entry in $entries) {
        if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($entry)) {
            throw 'MEDIA_HOST_DIR cannot contain wildcard characters'
        }
        if ($entry.StartsWith('\\') -or $entry.StartsWith('//')) {
            throw 'MEDIA_HOST_DIR cannot use UNC network paths'
        }
        if ($entry -notmatch '^[A-Za-z]:[\\/]') {
            throw 'MEDIA_HOST_DIR entries must be absolute Windows drive paths'
        }
        $driveName = $entry.Substring(0, 1)
        if ($null -eq (Get-PSDrive -Name $driveName -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
            throw "MEDIA_HOST_DIR drive does not exist: $driveName"
        }
        $fullPath = [System.IO.Path]::GetFullPath($entry)
        $root = [System.IO.Path]::GetPathRoot($fullPath)
        while ($fullPath.Length -gt $root.Length -and ($fullPath.EndsWith('\') -or $fullPath.EndsWith('/'))) {
            $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
            throw 'MEDIA_HOST_DIR directory does not exist'
        }
        $item = Get-Item -LiteralPath $fullPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'MEDIA_HOST_DIR directory cannot be a reparse point'
        }
        $normalized = ([System.IO.Path]::GetFullPath($item.FullName)).Replace('\', '/')
        if (-not $seen.Add($normalized)) {
            throw 'MEDIA_HOST_DIR contains a duplicate directory'
        }

        $probe = Join-Path -Path $item.FullName -ChildPath ('.movie-harbor-write-probe-{0}' -f [Guid]::NewGuid().ToString('N'))
        try {
            $stream = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $stream.Dispose()
        } finally {
            if (Test-Path -LiteralPath $probe) {
                Remove-Item -LiteralPath $probe -Force
            }
        }
        [void]$directories.Add($normalized)
    }
    return @($directories)
}

function Read-VolumeMarker([string]$Directory, [int]$Volume) {
    $markerPath = Join-Path -Path $Directory -ChildPath '.movie-harbor-volume.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "media volume $Volume has no valid identity marker"
    }
    $item = Get-Item -LiteralPath $markerPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 4096) {
        throw "media volume $Volume has no valid identity marker"
    }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    } catch {
        throw "media volume $Volume has no valid identity marker"
    }
    if (-not (Test-ExactProperties $marker @('version', 'volume')) -or $marker.version -ne 1 -or $marker.volume -ne $Volume) {
        throw "media volume $Volume identity marker does not match"
    }
}

function Initialize-MediaVolumes([string[]]$Directories, [string]$StatePath, [string]$OutputPath) {
    $registered = $null
    if (Test-Path -LiteralPath $StatePath) {
        if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
            throw 'media volume registration is invalid; restore it from backup'
        }
        try {
            $stateItem = Get-Item -LiteralPath $StatePath -Force
            if (($stateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $stateItem.Length -gt 1048576) {
                throw 'invalid state entry'
            }
            $registered = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        } catch {
            throw 'media volume registration is invalid; restore it from backup'
        }
        if (-not (Test-ExactProperties $registered @('version', 'directories')) -or
            $registered.version -ne 1 -or $null -eq $registered.directories -or @($registered.directories).Count -eq 0) {
            throw 'media volume registration is invalid; restore it from backup'
        }
    } else {
        if (Test-Path -LiteralPath $OutputPath) {
            throw 'media volume registration is missing; restore it before starting'
        }
        for ($volume = 0; $volume -lt $Directories.Count; $volume += 1) {
            $markerPath = Join-Path -Path $Directories[$volume] -ChildPath '.movie-harbor-volume.json'
            if (Test-Path -LiteralPath $markerPath) {
                throw 'media volume registration is missing; restore it before starting'
            }
        }
    }

    $previous = if ($null -eq $registered) { @() } else { @($registered.directories) }
    if ($previous.Count -gt $Directories.Count) {
        throw 'registered media volume paths cannot be removed'
    }
    for ($volume = 0; $volume -lt $previous.Count; $volume += 1) {
        if (-not [string]::Equals([string]$previous[$volume], $Directories[$volume], [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'registered media volume paths cannot be replaced or reordered'
        }
    }

    for ($volume = 0; $volume -lt $Directories.Count; $volume += 1) {
        $markerPath = Join-Path -Path $Directories[$volume] -ChildPath '.movie-harbor-volume.json'
        if ($volume -lt $previous.Count) {
            Read-VolumeMarker $Directories[$volume] $volume
        } else {
            if (Test-Path -LiteralPath $markerPath) {
                throw "new media volume $volume already has an identity marker"
            }
            if ($volume -gt 0 -and @(Get-ChildItem -LiteralPath $Directories[$volume] -Force).Count -ne 0) {
                throw "new media volume $volume must be empty"
            }
        }
    }

    if ($previous.Count -eq $Directories.Count) {
        return
    }
    $state = [ordered]@{ version = 1; directories = @($Directories) }
    $stateJson = ($state | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    Write-Utf8NoBomAtomic $StatePath $stateJson
    for ($volume = $previous.Count; $volume -lt $Directories.Count; $volume += 1) {
        $markerPath = Join-Path -Path $Directories[$volume] -ChildPath '.movie-harbor-volume.json'
        $marker = [ordered]@{ version = 1; volume = $volume }
        Write-Utf8NoBomAtomic $markerPath (($marker | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine)
    }
}

function New-StorageCompose([string[]]$Directories) {
    $initMounts = New-Object System.Collections.ArrayList
    $apiMounts = New-Object System.Collections.ArrayList
    $caddyMounts = New-Object System.Collections.ArrayList
    $mediaDirectories = New-Object System.Collections.ArrayList
    for ($volume = 0; $volume -lt $Directories.Count; $volume += 1) {
        $source = $Directories[$volume].Replace('$', '$$')
        [void]$initMounts.Add([ordered]@{
            type = 'bind'; source = $source; target = "/media/volumes/$volume"
            bind = [ordered]@{ create_host_path = $false }
        })
        [void]$apiMounts.Add([ordered]@{
            type = 'bind'; source = $source; target = "/media/volumes/$volume"
            bind = [ordered]@{ create_host_path = $false }
        })
        [void]$caddyMounts.Add([ordered]@{
            type = 'bind'; source = $source; target = "/srv/media/volumes/$volume"; read_only = $true
            bind = [ordered]@{ create_host_path = $false }
        })
        [void]$mediaDirectories.Add("/media/volumes/$volume")
    }
    return [ordered]@{
        services = [ordered]@{
            'media-init' = [ordered]@{ volumes = @($initMounts) }
            api = [ordered]@{
                environment = [ordered]@{ MEDIA_DIRS = (@($mediaDirectories) -join ';') }
                volumes = @($apiMounts)
            }
            caddy = [ordered]@{ volumes = @($caddyMounts) }
        }
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Windows is required'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Windows 64-bit is required'
    }
    $packageRoot = $PSScriptRoot
    $envPath = Join-Path -Path $packageRoot -ChildPath '.env'
    $composePath = Join-Path -Path $packageRoot -ChildPath 'compose.yml'
    $outputPath = Join-Path -Path $packageRoot -ChildPath 'compose.storage.generated.json'
    $statePath = Join-Path -Path $packageRoot -ChildPath '.movie-harbor-storage-state.json'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        throw '.env is missing'
    }
    if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
        throw 'compose.yml is missing'
    }

    $databaseDirectory = Get-DatabaseHostDirectory $envPath

    $dockerPlatform = (docker info --format '{{.OSType}}/{{.Architecture}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Desktop is unavailable'
    }
    $dockerParts = @($dockerPlatform.Split([char]'/'))
    if ($dockerParts.Count -ne 2 -or $dockerParts[0] -ne 'linux') {
        throw "Docker Desktop must run Linux containers, found $dockerPlatform"
    }
    docker compose version --short | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose v2 is unavailable'
    }

    $directories = @(Get-MediaHostDirectories $envPath)
    Initialize-MediaVolumes $directories $statePath $outputPath
    $storageCompose = New-StorageCompose $directories
    $storageJson = ($storageCompose | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    Write-Utf8NoBomAtomic $outputPath $storageJson

    Push-Location $packageRoot
    try {
        docker compose --env-file .env -f compose.yml -f compose.storage.generated.json up -d --no-build --wait
        if ($LASTEXITCODE -ne 0) {
            throw 'docker compose startup failed'
        }
    } finally {
        Pop-Location
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
}

export function renderStartScript(version, platform = "linux/amd64") {
  validateVersion(version);
  platformInfo(platform);
  return String.raw`#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$package_root"

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required to run start.sh; Windows deployments should use start.ps1' >&2
  exit 1
fi

daemon_platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
case "$daemon_platform" in
  linux/*) ;;
  *)
  echo "Docker must run Linux containers, found $daemon_platform" >&2
  exit 1
  ;;
esac
docker compose version --short >/dev/null

node --input-type=module <<'MOVIE_HARBOR_STORAGE_GENERATOR'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, writeSync,
} from "node:fs";
import path from "node:path";

const markerName = ".movie-harbor-volume.json";
const statePath = path.resolve(".movie-harbor-storage-state.json");
const outputPath = path.resolve("compose.storage.generated.json");
const envPath = path.resolve(".env");
function fail(message) { throw new Error(message); }
function exists(value) {
  try { lstatSync(value); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function atomicWrite(target, content, mode = 0o600) {
  const temporary = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + "." + Date.now() + ".tmp");
  const descriptor = openSync(temporary, "wx", mode);
  try { fchmodSync(descriptor, mode); writeSync(descriptor, content); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, target);
  const parent = openSync(path.dirname(target), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function exactObject(value, names) {
  return value && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
}
function readMarker(directory, volume) {
  let descriptor;
  try {
    descriptor = openSync(path.join(directory, markerName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) fail("media volume " + volume + " has no valid identity marker");
    const marker = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!exactObject(marker, ["version", "volume"]) || marker.version !== 1 || marker.volume !== volume) {
      fail("media volume " + volume + " identity marker does not match");
    }
  } catch (error) {
    if (/identity marker/.test(error.message)) throw error;
    fail("media volume " + volume + " has no valid identity marker");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
const line = readFileSync(envPath, "utf8").split(/\r?\n/).find(value => value.startsWith("MEDIA_HOST_DIR="));
if (!line) fail("MEDIA_HOST_DIR is missing from .env");
const value = line.slice("MEDIA_HOST_DIR=".length);
const entries = value.split(";").map(entry => entry.trim());
if (!entries.length || entries.some(entry => !entry)) fail("MEDIA_HOST_DIR contains an empty directory entry");
const directories = entries.map((entry, index) => {
  if (!path.isAbsolute(entry) && (entries.length !== 1 || index !== 0)) fail("multi-volume paths must be absolute");
  const resolved = path.isAbsolute(entry) ? entry : path.resolve(path.dirname(envPath), entry);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("MEDIA_HOST_DIR entry is not a directory");
  return realpathSync(resolved);
});
if (new Set(directories).size !== directories.length) fail("MEDIA_HOST_DIR contains a duplicate directory");

let state = null;
if (exists(statePath)) {
  const stat = lstatSync(statePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("media volume registration is invalid");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!exactObject(state, ["version", "directories"]) || state.version !== 1 ||
      !Array.isArray(state.directories) || state.directories.length === 0) fail("media volume registration is invalid");
} else if (exists(outputPath) || directories.some(directory => exists(path.join(directory, markerName)))) {
  fail("media volume registration is missing; restore it before starting");
}
const previous = state?.directories ?? [];
if (previous.length > directories.length || previous.some((directory, volume) => directory !== directories[volume])) {
  fail("registered media volume paths cannot be replaced, reordered or removed");
}
for (const [volume, directory] of directories.entries()) {
  const markerPath = path.join(directory, markerName);
  if (volume < previous.length) readMarker(directory, volume);
  else {
    if (exists(markerPath)) fail("new media volume " + volume + " already has an identity marker");
    if (volume > 0 && readdirSync(directory).length !== 0) fail("new media volume " + volume + " must be empty");
  }
}
if (previous.length !== directories.length) {
  atomicWrite(statePath, JSON.stringify({ version: 1, directories }, null, 2) + "\n");
  for (let volume = previous.length; volume < directories.length; volume += 1) {
    atomicWrite(path.join(directories[volume], markerName), JSON.stringify({ version: 1, volume }) + "\n", 0o644);
  }
}
const mounts = (root, readOnly) => directories.map((source, volume) => ({
  type: "bind", source: source.replaceAll("$", () => "$$"), target: root + "/" + volume,
  ...(readOnly ? { read_only: true } : {}), bind: { create_host_path: false },
}));
const generated = { services: {
  "media-init": { volumes: mounts("/media/volumes", false) },
  api: {
    environment: { MEDIA_DIRS: directories.map((_, volume) => "/media/volumes/" + volume).join(";") },
    volumes: mounts("/media/volumes", false),
  },
  caddy: { volumes: mounts("/srv/media/volumes", true) },
} };
atomicWrite(outputPath, JSON.stringify(generated, null, 2) + "\n");
MOVIE_HARBOR_STORAGE_GENERATOR

docker compose --env-file .env -f compose.yml -f compose.storage.generated.json up -d --no-build --wait
`;
}

export function renderBundleReadme(version, platform = DEFAULT_PLATFORM) {
  const tags = imageTags(version, platform);
  const { os, architecture } = platformInfo(platform);
  const imagePlatform = `${os}/${architecture}`;
  const deployment = platform === "linux/amd64"
    ? [
        "需要 Windows 11 64 位、Docker Desktop WSL2 后端、Linux containers 和 Docker Compose v2。解压后在 Windows PowerShell 5.1 或更高版本中执行：",
        "",
        "```powershell",
        ".\\load-images.ps1",
        "Copy-Item .env.example .env",
        "# 编辑 .env；Windows 必须把相对默认值改为正斜杠绝对盘符路径，例如：",
        "# DATABASE_HOST_DIR=D:/MovieHarbor/postgres",
        "# MEDIA_HOST_DIR=D:/MovieHarbor/media;E:/MovieHarbor/media",
        ".\\start.ps1",
        "```",
      ]
    : [
        `需要 Node.js、Docker Engine、Docker Compose v2 和 \`${imagePlatform}\`。解压后执行：`,
        "",
        "```sh",
        "./load-images.sh",
        "cp .env.example .env",
        "# 按下方配置说明编辑 .env；MEDIA_HOST_DIR 至少包含一个现存目录。",
        "./start.sh",
        "```",
      ];
  const legacyLinuxUpgrade = [
    "## 旧 Linux 单卷升级",
    "",
    ...(platform === "linux/amd64"
      ? ["本节只适用于在 Linux AMD64 主机上部署此包；Windows PowerShell 部署不得运行 shell 升级入口。", ""]
      : []),
    "旧版 Linux 单卷的媒体根可能由 `10001:10001` 持有且权限为 `0700`，普通启动无法安全登记。先停止旧服务，并对数据库、原媒体目录和原 `.env` 做一致备份；保留原 `.env`，确保 `MEDIA_HOST_DIR` 仍只有原目录且原盘在线。然后在解压目录执行：",
    "",
    "```sh",
    "./upgrade-media-storage.sh --confirm-existing-volume-zero",
    "./start.sh",
    "```",
    "",
    "升级入口使用包内 `upgrade-media-storage.mjs` 与 `storage-compose.mjs`，只登记原卷 0 并修正卷根和标记权限，不递归修改或迁移媒体，也不会启动应用。升级中断时保留 pending 和原数据，核对原盘后重跑同一条升级命令；不要删除登记或标记来绕过校验。新部署和已经正常登记的部署不要运行此入口。",
    "",
  ];
  const dataDirectoryGuidance = platform === "linux/amd64"
    ? "Windows 的 `start.ps1` 要求 `DATABASE_HOST_DIR` 是现存、可写的本地绝对盘符目录，并在写任何媒体登记前校验；`.env.example` 的相对默认值必须改为 Windows 绝对盘符路径。`MEDIA_HOST_DIR` 中的每项也必须预先存在。Linux AMD64 使用 `start.sh` 时仍可使用交付目录下的单卷相对默认值。升级前请同时备份数据库、登记文件和全部媒体卷。"
    : "`DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 默认使用交付目录下的 `./data/`；升级前请同时备份数据库、登记文件和全部媒体卷。";
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
    ...deployment,
    "",
    ...legacyLinuxUpgrade,
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
    `${dataDirectoryGuidance} 停止服务使用 \`docker compose down\`，保留数据时不要添加 \`--volumes\`。`,
    "",
  ].join("\n");
}
