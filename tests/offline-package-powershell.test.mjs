import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  imageTags,
  renderLoadPowerShell,
  renderStartPowerShell,
  renderStartScript,
} from "../tools/offline-package.mjs";

const VERSION = "test-v1";
const PLATFORM = "linux/amd64";
const DELIVERY_FILES = [
  ".env.example", "Caddyfile", "README.md", "compose.yml", "images.tar",
  "load-images.sh", "load-images.ps1", "start.sh", "start.ps1",
];
const POWERSHELL = process.platform === "win32" ? "powershell.exe" : undefined;

test("packaged start.sh generates the same multi-volume mounts before fixed Compose startup", async t => {
  const root = await mkdtemp(join(tmpdir(), "offline-start-shell-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle with spaces");
  const bin = join(root, "bin");
  const volume0 = join(root, "media $ zero");
  const volume1 = join(root, "media one");
  await Promise.all([mkdir(bundle), mkdir(bin), mkdir(volume0), mkdir(volume1)]);
  await mkdir(join(volume0, "poster"));
  await writeFile(join(bundle, "compose.yml"), "{}\n");
  await writeFile(join(bundle, ".env"), `MEDIA_HOST_DIR=${volume0};${volume1}\n`);
  await writeFile(join(bundle, "start.sh"), renderStartScript(VERSION, PLATFORM));
  await chmod(join(bundle, "start.sh"), 0o755);
  const log = join(root, "docker.log");
  await writeFile(join(bin, "docker"), `#!/usr/bin/env node\n${DOCKER_DOUBLE}`);
  await chmod(join(bin, "docker"), 0o755);

  const result = spawnSync("sh", [join(bundle, "start.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      DOCKER_TEST_LOG: log,
      DOCKER_TEST_MODE: "success",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
    ["compose", "version", "--short"],
    ["compose", "--env-file", ".env", "-f", "compose.yml", "-f", "compose.storage.generated.json", "up", "-d", "--no-build", "--wait"],
  ]);
  const generated = JSON.parse(await readFile(join(bundle, "compose.storage.generated.json"), "utf8"));
  assert.equal(generated.services.api.environment.MEDIA_DIRS, "/media/volumes/0;/media/volumes/1");
  assert.deepEqual(generated.services.api.volumes.map(value => value.target), [
    "/media/volumes/0", "/media/volumes/1",
  ]);
  assert.deepEqual(generated.services.caddy.volumes.map(value => value.target), [
    "/srv/media/volumes/0", "/srv/media/volumes/1",
  ]);
  assert.equal(
    generated.services.api.volumes[0].source.includes("$$"),
    true,
    generated.services.api.volumes[0].source,
  );
  assert.equal(generated.services.caddy.volumes.every(value => value.read_only === true), true);
});

test("ARM64 packaged start.sh initializes and starts the default single volume", async t => {
  const root = await mkdtemp(join(tmpdir(), "offline-start-arm64-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  const bin = join(root, "bin");
  const volume = join(bundle, "data", "media");
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(volume, { recursive: true })]);
  await mkdir(join(volume, "poster"));
  await writeFile(join(bundle, "compose.yml"), "{}\n");
  await writeFile(join(bundle, ".env"), "MEDIA_HOST_DIR=./data/media\n");
  await writeFile(join(bundle, "start.sh"), renderStartScript(VERSION, "linux/arm64"));
  await chmod(join(bundle, "start.sh"), 0o755);
  const log = join(root, "docker.log");
  await writeFile(join(bin, "docker"), `#!/usr/bin/env node\n${DOCKER_DOUBLE}`);
  await chmod(join(bin, "docker"), 0o755);

  const result = spawnSync("sh", [join(bundle, "start.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      DOCKER_TEST_LOG: log,
      DOCKER_TEST_MODE: "success",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(volume, ".movie-harbor-volume.json"), "utf8")), {
    version: 1, volume: 0,
  });
  const generated = JSON.parse(await readFile(join(bundle, "compose.storage.generated.json"), "utf8"));
  assert.equal(generated.services.api.environment.MEDIA_DIRS, "/media/volumes/0");
  assert.equal(generated.services.api.volumes[0].target, "/media/volumes/0");
  assert.equal(generated.services.caddy.volumes[0].target, "/srv/media/volumes/0");
});

test("renders a PowerShell loader that verifies the exact package before importing images", () => {
  const script = renderLoadPowerShell(VERSION, PLATFORM);
  const lastHash = script.lastIndexOf("Get-FileHash");
  const load = script.indexOf("docker image load --input");

  assert.match(script, /\$PSScriptRoot/);
  assert.match(script, /Get-Content -LiteralPath/);
  assert.match(script, /Get-FileHash -LiteralPath/);
  assert.match(script, /\^\(\?\<hash\>\(\?i:\[0-9a-f\]\{64\}\)\) {2}\(\?\<name\>/);
  const hashGroup = script.match(/\(\?<([A-Za-z][A-Za-z0-9]*)>\(\?i:\[0-9a-f\]\{64\}\)\)/);
  assert.ok(hashGroup, "the checksum regex must capture the hash in a named group");
  assert.ok(
    script.includes(`$match.Groups['${hashGroup[1]}'].Value.ToLowerInvariant()`),
    "the checksum parser must read the same named group defined by its regex",
  );
  assert.ok(
    script.includes("(?<name>[^/\\\\]+)$"),
    "the manifest grammar must reject both path separator forms",
  );
  assert.match(script, /\$entries\.Count -ne \$expectedFiles\.Count/);
  assert.match(script, /\$seen\.ContainsKey\(\$name\)/);
  assert.ok(lastHash >= 0, "the loader must hash package files");
  assert.ok(load > lastHash, "Docker must not run until every checksum has passed");
  for (const file of DELIVERY_FILES) assert.ok(script.includes(`'${file}'`), file);
  for (const tag of imageTags(VERSION, PLATFORM)) assert.ok(script.includes(`'${tag}'`), tag);
  assert.match(script, /docker image inspect --format '\{\{\.Os\}\}\/\{\{\.Architecture\}\}'/);
  assert.match(script, /linux\/amd64/);
  assert.doesNotMatch(script, /Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(script, /docker (?:pull|build)|curl|wget/i);
});

test("only the AMD64 package exposes the PowerShell image loader", () => {
  assert.throws(() => renderLoadPowerShell(VERSION, "linux/arm64"), /only supported.*linux\/amd64/i);
  assert.throws(() => renderLoadPowerShell(VERSION, "windows/amd64"), /unsupported platform/i);
});

test("renders a PowerShell deployment entrypoint with strict storage and Docker boundaries", () => {
  const script = renderStartPowerShell(VERSION, PLATFORM);

  assert.match(script, /\$PSScriptRoot/);
  assert.match(script, /OSVersion\.Platform[^\n]*Win32NT/);
  assert.match(script, /Get-Content -LiteralPath/);
  assert.match(script, /MEDIA_HOST_DIR/);
  assert.match(script, /rawValue\.Split\(\[char\]';'\)/);
  assert.match(script, /ContainsWildcardCharacters/);
  assert.match(script, /cannot use UNC network paths/);
  assert.match(script, /absolute Windows drive paths/);
  assert.match(script, /Get-PSDrive[^\n]*-PSProvider FileSystem/);
  assert.match(script, /StringComparer\]::OrdinalIgnoreCase/);
  assert.match(script, /new media volume \$volume must be empty/);
  assert.match(script, /\.movie-harbor-volume\.json/);
  assert.match(script, /\.movie-harbor-storage-state\.json/);
  assert.match(script, /compose\.storage\.generated\.json/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /ConvertTo-Json -Depth 12/);
  assert.match(script, /System\.Text\.UTF8Encoding\]\:\:new\(\$false\)/);
  assert.match(script, /Move-Item -LiteralPath/);
  assert.match(script, /docker info --format '\{\{\.OSType\}\}\/\{\{\.Architecture\}\}'/);
  assert.match(script, /docker compose version --short/);
  assert.match(
    script,
    /docker compose --env-file \.env -f compose\.yml -f compose\.storage\.generated\.json up -d --no-build --wait/,
  );
  assert.match(script, /MEDIA_DIRS/);
  assert.match(script, /\/media\/volumes\/\$volume/);
  assert.match(script, /\/srv\/media\/volumes\/\$volume/);
  assert.match(script, /create_host_path["']?\s*[=:]\s*\$false/);
  assert.match(script, /read_only["']?\s*[=:]\s*\$true/);
  assert.doesNotMatch(script, /Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(script, /Start-Process[^\n]*-Verb\s+RunAs|Set-ExecutionPolicy|switch[^\n]*container/i);
  assert.doesNotMatch(script, /docker (?:pull|build)|curl|wget/i);
});

test("PowerShell deployment entrypoint only targets the AMD64 package", () => {
  assert.throws(() => renderStartPowerShell(VERSION, "linux/arm64"), /only supported.*linux\/amd64/i);
  assert.throws(() => renderStartPowerShell(VERSION, "windows/amd64"), /unsupported platform/i);
});

async function checksumLines(directory) {
  const lines = [];
  for (const name of DELIVERY_FILES) {
    const bytes = await readFile(join(directory, name));
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

const DOCKER_DOUBLE = String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_TEST_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'info') {
  console.log(process.env.DOCKER_TEST_MODE === 'windows-daemon' ? 'windows/amd64' : 'linux/amd64');
  process.exit(0);
}
if (args[0] === 'compose' && args[1] === 'version') {
  console.log('2.39.1');
  process.exit(0);
}
if (args[0] === 'compose' && args.includes('up')) {
  process.exit(process.env.DOCKER_TEST_MODE === 'startup-failure' ? 1 : 0);
}
if (args[0] === 'image' && args[1] === 'load') {
  process.exit(0);
}

if (args[0] === 'image' && args[1] === 'inspect') {
  const image = args.at(-1);
  if (process.env.DOCKER_TEST_MODE === 'missing-image' && image.includes('public-web')) {
    console.error('image missing');
    process.exit(1);
  }
  if (process.env.DOCKER_TEST_MODE === 'wrong-architecture' && image.includes('admin-web')) {
    console.log('linux/arm64');
  } else {
    console.log('linux/amd64');
  }
  process.exit(0);
}
console.error('unexpected docker command: ' + args.join(' '));
process.exit(1);
`;

function asWindowsPath(value) {
  return value.replaceAll("\\", "/");
}

function missingWindowsDrivePath() {
  for (let code = "Z".charCodeAt(0); code >= "D".charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (!existsSync(drive)) return `${String.fromCharCode(code)}:/movie-harbor-missing`;
  }
  throw new Error("Windows behavior test requires one unused drive letter");
}

function runStartPowerShell(bundle, root, env) {
  return spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(bundle, "start.ps1"),
  ], { cwd: root, env, encoding: "utf8" });
}

async function writeWindowsMediaEnv(bundle, mediaValue) {
  await writeFile(join(bundle, ".env"), [
    "# must not be evaluated as PowerShell",
    "ATTACK=$(Set-Content should-not-exist.txt attacked)",
    `MEDIA_HOST_DIR=\"${mediaValue}\"`,
    "MEDIA_HOST_DIR=Z:/ignored-duplicate",
  ].join("\r\n"));
}

async function startPowerShellFixture(t, mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "offline-start-powershell-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle with spaces");
  const bin = join(root, "bin");
  const volume0 = join(root, "media $ zero");
  const volume1 = join(root, "media one");
  await Promise.all([mkdir(bundle), mkdir(bin), mkdir(volume0), mkdir(volume1)]);
  await mkdir(join(volume0, "poster"));
  await writeFile(join(bundle, "compose.yml"), "{}\n");
  await writeFile(join(bundle, "start.ps1"), renderStartPowerShell(VERSION, PLATFORM));
  const configuredVolume1 = mode === "missing-directory" ? join(root, "missing") : volume1;
  if (mode === "nonempty-new-volume") await writeFile(join(volume1, "unexpected.txt"), "occupied");
  let mediaValue = `${asWindowsPath(volume0)};${asWindowsPath(configuredVolume1)}`;
  if (mode === "single-volume") mediaValue = asWindowsPath(volume0);
  if (mode === "missing-drive") mediaValue = missingWindowsDrivePath();
  if (mode === "duplicate") mediaValue = `${asWindowsPath(volume0)};${asWindowsPath(volume0)}`;
  if (mode === "relative") mediaValue = "relative/media";
  if (mode === "unc") mediaValue = "//server/share";
  if (mode === "wildcard") mediaValue = `${asWindowsPath(volume0)}/*`;
  if (mode === "empty-entry") mediaValue = `${asWindowsPath(volume0)};;${asWindowsPath(volume1)}`;
  await writeWindowsMediaEnv(bundle, mediaValue);
  await writeFile(join(bin, "docker-double.cjs"), DOCKER_DOUBLE);
  await writeFile(join(bin, "docker.cmd"), '@echo off\r\nnode "%~dp0docker-double.cjs" %*\r\n');
  await chmod(join(bin, "docker.cmd"), 0o755);
  if (mode === "marker-mismatch") {
    const directories = [asWindowsPath(volume0), asWindowsPath(volume1)];
    await writeFile(join(bundle, ".movie-harbor-storage-state.json"), JSON.stringify({
      version: 1, directories,
    }));
    await writeFile(join(volume0, ".movie-harbor-volume.json"), JSON.stringify({ version: 1, volume: 0 }));
    await writeFile(join(volume1, ".movie-harbor-volume.json"), JSON.stringify({ version: 1, volume: 9 }));
  }
  const log = join(root, "docker.log");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    DOCKER_TEST_LOG: log,
    DOCKER_TEST_MODE: mode,
  };
  const result = runStartPowerShell(bundle, root, env);
  const calls = (await readFile(log, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  return { bundle, calls, env, result, root, volume0, volume1 };
}

test("PowerShell deployment generates multi-volume storage and starts fixed Compose files", {
  skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
}, async t => {
  const fixture = await startPowerShellFixture(t);
  assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
  assert.deepEqual(fixture.calls, [
    ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
    ["compose", "version", "--short"],
    ["compose", "--env-file", ".env", "-f", "compose.yml", "-f", "compose.storage.generated.json", "up", "-d", "--no-build", "--wait"],
  ]);
  const outputBytes = await readFile(join(fixture.bundle, "compose.storage.generated.json"));
  assert.notDeepEqual([...outputBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const generated = JSON.parse(outputBytes.toString("utf8"));
  assert.equal(generated.services.api.environment.MEDIA_DIRS, "/media/volumes/0;/media/volumes/1");
  assert.deepEqual(generated.services.api.volumes.map(value => value.target), [
    "/media/volumes/0", "/media/volumes/1",
  ]);
  assert.deepEqual(generated.services.caddy.volumes.map(value => value.target), [
    "/srv/media/volumes/0", "/srv/media/volumes/1",
  ]);
  assert.equal(generated.services.api.volumes[0].source.includes("$$"), true);
  assert.equal(generated.services.caddy.volumes.every(value => value.read_only === true), true);
  assert.equal(generated.services.api.volumes.every(value => value.bind.create_host_path === false), true);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.volume0, ".movie-harbor-volume.json"), "utf8")), {
    version: 1, volume: 0,
  });
  assert.deepEqual(JSON.parse(await readFile(join(fixture.volume1, ".movie-harbor-volume.json"), "utf8")), {
    version: 1, volume: 1,
  });
  await assert.rejects(readFile(join(fixture.root, "should-not-exist.txt")), /ENOENT/);
});

for (const [mode, error] of [
  ["windows-daemon", /Linux containers/i],
  ["missing-directory", /does not exist/i],
  ["missing-drive", /drive does not exist/i],
  ["duplicate", /duplicate/i],
  ["relative", /absolute Windows drive paths/i],
  ["unc", /UNC network paths/i],
  ["wildcard", /wildcard/i],
  ["empty-entry", /empty directory entry/i],
  ["nonempty-new-volume", /must be empty/i],
  ["marker-mismatch", /identity marker does not match/i],
  ["startup-failure", /startup failed/i],
]) {
  test(`PowerShell deployment fails safely for ${mode}`, {
    skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
  }, async t => {
    const fixture = await startPowerShellFixture(t, mode);
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, error);
    if (mode !== "startup-failure") {
      assert.equal(fixture.calls.some(args => args.includes("up")), false);
    }
  });
}

test("PowerShell deployment accepts a normal registered restart", {
  skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
}, async t => {
  const fixture = await startPowerShellFixture(t);
  assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
  const restarted = runStartPowerShell(fixture.bundle, fixture.root, fixture.env);
  assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
});

test("PowerShell deployment permits only an empty volume appended at the end", {
  skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
}, async t => {
  const fixture = await startPowerShellFixture(t, "single-volume");
  assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
  await writeWindowsMediaEnv(
    fixture.bundle,
    `${asWindowsPath(fixture.volume0)};${asWindowsPath(fixture.volume1)}`,
  );
  const appended = runStartPowerShell(fixture.bundle, fixture.root, {
    ...fixture.env, DOCKER_TEST_MODE: "success",
  });
  assert.equal(appended.status, 0, appended.stderr || appended.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.volume1, ".movie-harbor-volume.json"), "utf8")), {
    version: 1, volume: 1,
  });
});

for (const [name, configure, error] of [
  ["reordered volumes", async fixture => writeWindowsMediaEnv(
    fixture.bundle,
    `${asWindowsPath(fixture.volume1)};${asWindowsPath(fixture.volume0)}`,
  ), /replaced or reordered/i],
  ["removed volume", async fixture => writeWindowsMediaEnv(
    fixture.bundle,
    asWindowsPath(fixture.volume0),
  ), /cannot be removed/i],
  ["missing registration", async fixture => rm(
    join(fixture.bundle, ".movie-harbor-storage-state.json"),
  ), /registration is missing/i],
  ["damaged registration", async fixture => writeFile(
    join(fixture.bundle, ".movie-harbor-storage-state.json"),
    "{damaged",
  ), /registration is invalid/i],
]) {
  test(`PowerShell deployment fails closed for ${name}`, {
    skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
  }, async t => {
    const fixture = await startPowerShellFixture(t);
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    await configure(fixture);
    const rerun = runStartPowerShell(fixture.bundle, fixture.root, fixture.env);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, error);
  });
}

async function powershellFixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "offline-powershell-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle with spaces");
  const bin = join(root, "bin");
  await Promise.all([mkdir(bundle), mkdir(bin)]);

  for (const name of DELIVERY_FILES) {
    await writeFile(
      join(bundle, name),
      name === "load-images.ps1" ? renderLoadPowerShell(VERSION, PLATFORM) : `fixture ${name}\n`,
    );
  }
  await writeFile(join(bundle, "SHA256SUMS"), await checksumLines(bundle));
  if (mode === "checksum-mismatch") await writeFile(join(bundle, "images.tar"), "tampered\n");

  await writeFile(join(bin, "docker-double.cjs"), DOCKER_DOUBLE);
  await writeFile(join(bin, "docker.cmd"), '@echo off\r\nnode "%~dp0docker-double.cjs" %*\r\n');
  await chmod(join(bin, "docker.cmd"), 0o755);
  const log = join(root, "docker.log");
  const result = spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(bundle, "load-images.ps1"),
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      DOCKER_TEST_LOG: log,
      DOCKER_TEST_MODE: mode,
    },
    encoding: "utf8",
  });
  const calls = (await readFile(log, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  return { bundle, result, calls };
}

for (const [mode, succeeds] of [
  ["success", true],
  ["checksum-mismatch", false],
  ["missing-image", false],
  ["wrong-architecture", false],
]) {
  test(`PowerShell loader handles ${mode} without bypassing verification`, {
    skip: POWERSHELL ? false : "requires Windows PowerShell 5.1+",
  }, async t => {
    const { bundle, result, calls } = await powershellFixture(t, mode);
    assert.equal(result.status === 0, succeeds, result.stderr || result.stdout);
    if (mode === "checksum-mismatch") {
      assert.deepEqual(calls, [], "checksum failure must happen before Docker is called");
      return;
    }
    assert.deepEqual(calls[0], ["image", "load", "--input", join(bundle, "images.tar")]);
    const inspectedTags = calls
      .filter(args => args[0] === "image" && args[1] === "inspect")
      .map(args => args.at(-1));
    if (mode === "missing-image") {
      assert.deepEqual(inspectedTags, imageTags(VERSION, PLATFORM).slice(0, 2));
    } else {
      assert.deepEqual(inspectedTags, imageTags(VERSION, PLATFORM));
    }
  });
}
