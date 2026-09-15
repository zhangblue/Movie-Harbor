import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseMediaHostDirs,
  readVolumeMarker,
  renderStorageCompose,
} from "../tools/storage-compose.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "movie-harbor-storage-compose-"));
}

function makeDirectory(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

test("parses existing semicolon-delimited host directories and renders isolated volume mounts", () => {
  const root = tempRoot();
  try {
    const first = makeDirectory(root, "disk one/media");
    const second = makeDirectory(root, "disk-two/media");
    const hostDirs = parseMediaHostDirs(`${first};${second}`);
    const config = renderStorageCompose(hostDirs);

    assert.deepEqual(config.services.api.volumes.map((mount) => mount.target), [
      "/media/volumes/0",
      "/media/volumes/1",
    ]);
    assert.deepEqual(config.services["media-init"].volumes.map((mount) => mount.source), [
      first,
      second,
    ]);
    assert.equal(config.services.api.environment.MEDIA_DIRS, "/media/volumes/0;/media/volumes/1");
    assert.equal(config.services.caddy.volumes[1].target, "/srv/media/volumes/1");
    assert.equal(config.services.caddy.volumes[1].read_only, true);
    assert.equal(config.services.api.volumes[0].bind.create_host_path, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe or unavailable host directory lists before Compose rendering", () => {
  const root = tempRoot();
  try {
    const first = makeDirectory(root, "one");
    const second = makeDirectory(root, "two");
    for (const value of [
      "",
      `${first};;${second}`,
      `${first};${first}`,
      `${first};./relative-new-volume`,
      `${first};${path.join(root, "missing")}`,
      `${first};${second};/tmp/evil;injection`,
    ]) {
      assert.throws(() => parseMediaHostDirs(value));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI writes only storage settings atomically and never copies unrelated dotenv secrets", () => {
  const root = tempRoot();
  try {
    const media = makeDirectory(root, "media");
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    writeFileSync(envFile, `POSTGRES_PASSWORD=never-copy-this\nMEDIA_HOST_DIR=${media}\nTRUST_PROXY_SECRET=also-never-copy-this\n`);

    execFileSync("node", ["tools/storage-compose.mjs", "--env", envFile, "--output", output], {
      cwd: projectRoot,
      stdio: "pipe",
    });

    const generated = readFileSync(output, "utf8");
    assert.doesNotMatch(generated, /never-copy-this|also-never-copy-this/);
    assert.deepEqual(JSON.parse(generated), renderStorageCompose([media]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup initializes only an existing volume zero or an empty appended volume", () => {
  const root = tempRoot();
  try {
    const first = makeDirectory(root, "existing-volume-zero");
    const second = makeDirectory(root, "empty-appended-volume");
    writeFileSync(path.join(first, "legacy-media.mp4"), "old media");
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    writeFileSync(envFile, `MEDIA_HOST_DIR=${first};${second}\n`);
    const fakeBin = makeDirectory(root, "bin");
    const dockerLog = path.join(root, "docker-arguments.json");
    writeFileSync(
      path.join(fakeBin, "docker"),
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$MOVIE_HARBOR_DOCKER_LOG\"\n",
      { mode: 0o755 },
    );

    const result = spawnSync("sh", ["tools/start-compose.sh"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MOVIE_HARBOR_ENV_FILE: envFile,
        MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT: output,
        MOVIE_HARBOR_DOCKER_LOG: dockerLog,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readVolumeMarker(first, 0), { version: 1, volume: 0 });
    assert.deepEqual(readVolumeMarker(second, 1), { version: 1, volume: 1 });
    assert.equal(
      readFileSync(dockerLog, "utf8"),
      [
        "compose",
        "-f",
        "docker-compose.yml",
        "-f",
        output,
        "--env-file",
        envFile,
        "up",
        "-d",
        "--build",
        "--wait",
        "",
      ].join("\n"),
    );

    const nonEmptyNewVolume = makeDirectory(root, "non-empty-appended-volume");
    writeFileSync(path.join(nonEmptyNewVolume, "do-not-adopt.txt"), "not ours");
    writeFileSync(envFile, `MEDIA_HOST_DIR=${first};${nonEmptyNewVolume}\n`);
    const rejected = spawnSync("sh", ["tools/start-compose.sh"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MOVIE_HARBOR_ENV_FILE: envFile,
        MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT: output,
        MOVIE_HARBOR_DOCKER_LOG: dockerLog,
      },
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(existsSync(path.join(nonEmptyNewVolume, ".movie-harbor-volume.json")), false);

    writeFileSync(path.join(second, ".movie-harbor-volume.json"), '{"version":1,"volume":0}');
    writeFileSync(envFile, `MEDIA_HOST_DIR=${first};${second}\n`);
    const mismatched = spawnSync("sh", ["tools/start-compose.sh"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MOVIE_HARBOR_ENV_FILE: envFile,
        MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT: output,
        MOVIE_HARBOR_DOCKER_LOG: dockerLog,
      },
    });
    assert.notEqual(mismatched.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
