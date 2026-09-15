import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseMediaHostDirs,
  readVolumeMarker,
  renderStorageCompose,
} from "../tools/storage-compose.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const dockerAvailable = (() => {
  if (process.env.MOVIE_HARBOR_RUN_DOCKER_INTEGRATION !== "1") return false;
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "movie-harbor-storage-compose-"));
}

function makeDirectory(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

test("Compose passes the default and configured per-volume reserve to the API", () => {
  for (const [configured, expected] of [[undefined, "10737418240"], ["21474836480", "21474836480"]]) {
    const environment = { ...process.env };
    delete environment.MEDIA_DISK_RESERVE_BYTES;
    if (configured !== undefined) environment.MEDIA_DISK_RESERVE_BYTES = configured;
    const config = JSON.parse(execFileSync("docker", ["compose", "--env-file", ".env.example", "-f", "docker-compose.yml", "config", "--format", "json"], {
      cwd: projectRoot, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(config.services.api.environment.MEDIA_DISK_RESERVE_BYTES, expected);
  }
});

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

test("rendered Compose escapes dollar signs in host directories", () => {
  const root = tempRoot();
  try {
    const media = makeDirectory(root, "disk$MOVIE_HARBOR_TEST_EXPANSION");
    assert.equal(
      renderStorageCompose([media]).services.api.volumes[0].source,
      media.replaceAll("$", () => "$$"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated Compose keeps a validated dollar-sign host directory literal", { skip: !dockerAvailable }, () => {
  const root = tempRoot();
  const project = `movie_harbor_mount_${process.pid}_${Date.now()}`;
  const composeFile = path.join(root, "compose.json");
  try {
    const media = makeDirectory(root, "disk$MOVIE_HARBOR_TEST_EXPANSION");
    makeDirectory(root, "diskwrong-directory");
    const mount = renderStorageCompose([media]).services.api.volumes[0];
    writeFileSync(
      composeFile,
      `${JSON.stringify({
        services: {
          "mount-check": {
            image: "alpine:3.22",
            command: ["sh", "-c", "sleep 30"],
            volumes: [{ ...mount, target: "/volume" }],
          },
        },
      })}\n`,
    );

    execFileSync("docker", ["compose", "-p", project, "-f", composeFile, "up", "-d"], {
      cwd: projectRoot,
      env: { ...process.env, MOVIE_HARBOR_TEST_EXPANSION: "wrong-directory" },
      stdio: "pipe",
    });
    const container = JSON.parse(
      execFileSync("docker", ["inspect", `${project}-mount-check-1`], { encoding: "utf8" }),
    )[0];
    assert.equal(container.Mounts.find((entry) => entry.Destination === "/volume").Source, media);
  } finally {
    try {
      execFileSync("docker", ["compose", "-p", project, "-f", composeFile, "down", "--volumes"], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("an initialized marker has permission for a different host UID to read", () => {
  const root = tempRoot();
  try {
    const media = makeDirectory(root, "media");
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    writeFileSync(envFile, `MEDIA_HOST_DIR=${media}\n`);
    execFileSync("node", ["tools/storage-compose.mjs", "--env", envFile, "--output", output, "--initialize"], {
      cwd: projectRoot,
      stdio: "pipe",
    });

    assert.notEqual(
      statSync(path.join(media, ".movie-harbor-volume.json")).mode & 0o004,
      0,
      "the non-secret marker must be readable by a different host UID",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker creation remains readable when the deployer uses a restrictive umask", () => {
  const root = tempRoot();
  try {
    const media = makeDirectory(root, "media");
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    writeFileSync(envFile, `MEDIA_HOST_DIR=${media}\n`);
    const result = spawnSync(
      "sh",
      [
        "-c",
        "umask 077; exec node \"$@\"",
        "sh",
        "tools/storage-compose.mjs",
        "--env",
        envFile,
        "--output",
        output,
        "--initialize",
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(statSync(path.join(media, ".movie-harbor-volume.json")).mode & 0o004, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an initialized marker is readable by the API container user", { skip: !dockerAvailable }, () => {
  const root = tempRoot();
  try {
    const media = makeDirectory(root, "media");
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    writeFileSync(envFile, `MEDIA_HOST_DIR=${media}\n`);
    execFileSync("node", ["tools/storage-compose.mjs", "--env", envFile, "--output", output, "--initialize"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    assert.equal(
      execFileSync(
        "docker",
        ["run", "--rm", "--user", "10001:10001", "--mount", `type=bind,src=${media},dst=/volume,readonly`, "alpine:3.22", "cat", "/volume/.movie-harbor-volume.json"],
        { encoding: "utf8" },
      ),
      '{"version":1,"volume":0}',
    );
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

test("startup rejects symlinked volume roots and markers before calling Docker", () => {
  const root = tempRoot();
  try {
    const target = makeDirectory(root, "real-volume");
    const rootLink = path.join(root, "volume-link");
    symlinkSync(target, rootLink);
    const envFile = path.join(root, "deployment.env");
    const output = path.join(root, "compose.storage.generated.json");
    const fakeBin = makeDirectory(root, "bin");
    const dockerLog = path.join(root, "docker-called");
    writeFileSync(path.join(fakeBin, "docker"), "#!/bin/sh\ntouch \"$MOVIE_HARBOR_DOCKER_LOG\"\n", {
      mode: 0o755,
    });
    const run = (directory) => {
      writeFileSync(envFile, `MEDIA_HOST_DIR=${directory}\n`);
      rmSync(dockerLog, { force: true });
      return spawnSync("sh", ["tools/start-compose.sh"], {
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
    };

    const rootResult = run(rootLink);
    assert.notEqual(rootResult.status, 0);
    assert.equal(existsSync(dockerLog), false);

    const trailingSlashRootResult = run(`${rootLink}${path.sep}`);
    assert.notEqual(trailingSlashRootResult.status, 0);
    assert.equal(existsSync(dockerLog), false);

    const markerTarget = path.join(root, "marker-target.json");
    writeFileSync(markerTarget, '{"version":1,"volume":0}');
    symlinkSync(markerTarget, path.join(target, ".movie-harbor-volume.json"));
    const markerResult = run(target);
    assert.notEqual(markerResult.status, 0);
    assert.equal(existsSync(dockerLog), false);

    rmSync(path.join(target, ".movie-harbor-volume.json"));
    mkdirSync(path.join(target, ".movie-harbor-volume.json"));
    const directoryMarkerResult = run(target);
    assert.notEqual(directoryMarkerResult.status, 0);
    assert.equal(existsSync(dockerLog), false);

    const danglingMarkerRoot = makeDirectory(root, "dangling-marker-volume");
    const danglingMarker = path.join(danglingMarkerRoot, ".movie-harbor-volume.json");
    symlinkSync(path.join(root, "missing-marker-target.json"), danglingMarker);
    const danglingMarkerResult = run(danglingMarkerRoot);
    assert.notEqual(danglingMarkerResult.status, 0);
    assert.equal(existsSync(dockerLog), false);
    assert.equal(lstatSync(danglingMarker).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Caddy serves only a volume-scoped controlled media key", { skip: !dockerAvailable }, async () => {
  const root = tempRoot();
  const container = `movie-harbor-caddy-${process.pid}-${Date.now()}`;
  try {
    const poster = path.join(root, "poster/aa");
    mkdirSync(poster, { recursive: true });
    const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    writeFileSync(path.join(poster, key), "poster bytes");
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--publish",
        "127.0.0.1::80",
        "--env",
        "TRUST_PROXY_SECRET=test",
        "--mount",
        `type=bind,src=${path.join(projectRoot, "Caddyfile")},dst=/etc/caddy/Caddyfile,readonly`,
        "--mount",
        `type=bind,src=${root},dst=/srv/media/volumes/0,readonly`,
        "caddy:2.10-alpine",
      ],
      { stdio: "pipe" },
    );
    const port = execFileSync("docker", ["port", container, "80/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .at(-1);
    let allowed;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        allowed = await request(`http://127.0.0.1:${port}/media/v0/poster/aa/${key}`);
        if (allowed.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(allowed, { status: 200, body: "poster bytes" });
    assert.equal((await request(`http://127.0.0.1:${port}/media/v0/.movie-harbor-volume.json`)).status, 404);
    assert.equal((await request(`http://127.0.0.1:${port}/media/poster/aa/${key}`)).status, 404);
  } finally {
    try {
      execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
