import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { imageTags, renderLoadPowerShell } from "../tools/offline-package.mjs";

const VERSION = "test-v1";
const PLATFORM = "linux/amd64";
const DELIVERY_FILES = [
  ".env.example", "Caddyfile", "README.md", "compose.yml", "images.tar",
  "load-images.sh", "load-images.ps1",
];
const POWERSHELL = process.platform === "win32" ? "powershell.exe" : undefined;

test("renders a PowerShell loader that verifies the exact package before importing images", () => {
  const script = renderLoadPowerShell(VERSION, PLATFORM);
  const lastHash = script.lastIndexOf("Get-FileHash");
  const load = script.indexOf("docker image load --input");

  assert.match(script, /\$PSScriptRoot/);
  assert.match(script, /Get-Content -LiteralPath/);
  assert.match(script, /Get-FileHash -LiteralPath/);
  assert.match(script, /\^\(\?i:\[0-9a-f\]\{64\}\) {2}\(\?\<name\>/);
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
