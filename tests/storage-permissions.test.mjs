import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const runDockerIntegration = process.env.MOVIE_HARBOR_RUN_DOCKER_INTEGRATION === "1";

function docker(args, input) {
  return spawnSync("docker", args, {
    cwd: projectRoot, encoding: "utf8", input, timeout: 60_000,
  });
}

function succeeded(result, action) {
  assert.equal(result.status, 0, `${action}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("a non-root Linux deployer can restart after production media-init without rewriting volume markers", {
  skip: !runDockerIntegration,
}, (t) => {
  // Regression: mode 0700 on the API-owned root prevents the deployment UID
  // from reading its existing marker, so start-compose aborts before Docker.
  const root = mkdtempSync(path.join(os.tmpdir(), "movie-harbor-permissions-"));
  const project = `mh-permissions-${randomUUID()}`;
  const names = ["deployment", "zero", "one"].map((name) => `${project}-${name}`);
  const created = [];
  const targets = ["/deployment", "/media/volumes/0", "/media/volumes/1"];
  const override = path.join(root, "compose.json");
  const compose = ["compose", "-p", project, "--env-file", ".env.example", "-f", "docker-compose.yml", "-f", override];
  let composeUsed = false;
  const containerNode = (uid, source) => docker([
    "run", "--rm", "--interactive", "--network", "none", "--user", `${uid}:${uid}`,
    "--mount", `type=bind,src=${projectRoot},dst=/project,readonly`,
    ...names.flatMap((name, index) => ["--mount", `type=volume,src=${name},dst=${targets[index]}`]),
    "--workdir", "/project", "node:24-alpine", "node", "--input-type=module", "-",
  ], source);
  const start = () => containerNode(1000, `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    assert.equal(process.getuid(), 1000);
    const result = spawnSync("sh", ["tools/start-compose.sh"], {
      encoding: "utf8", env: {
        ...process.env, PATH: "/deployment/bin:" + process.env.PATH,
        MOVIE_HARBOR_ENV_FILE: "/deployment/config.env",
        MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT: "/deployment/compose.storage.generated.json",
      },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  `);
  const snapshot = () => JSON.parse(succeeded(containerNode(0, `
    import { readFileSync, statSync } from "node:fs";
    const stats = (file) => {
      const value = statSync(file, { bigint: true });
      return { inode: String(value.ino), mtimeNs: String(value.mtimeNs), mode: Number(value.mode & 0o777n) };
    };
    console.log(JSON.stringify([0, 1].map((volume) => {
      const root = "/media/volumes/" + volume;
      return {
        marker: { ...stats(root + "/.movie-harbor-volume.json"), content: readFileSync(root + "/.movie-harbor-volume.json", "utf8") },
        privateDirectories: [".incoming", ".quarantine", ".operations"].map(name => stats(root + "/" + name)),
        media: { ...stats(root + "/video/ab/private.mp4"), content: readFileSync(root + "/video/ab/private.mp4", "utf8") },
      };
    })));
  `), "read Linux volume metadata"));

  try {
    for (const name of names) {
      succeeded(docker(["volume", "create", name]), "create isolated Linux volume");
      created.push(name);
    }
    writeFileSync(override, JSON.stringify({
      services: {
        "media-init": {
          volumes: [0, 1].map((volume) => ({
            type: "volume", source: `media${volume}`, target: `/media/volumes/${volume}`,
          })),
        },
      },
      volumes: Object.fromEntries([0, 1].map((volume) => [`media${volume}`, { external: true, name: names[volume + 1] }])),
    }));
    succeeded(containerNode(0, `
      import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
      for (const root of ["/deployment", "/media/volumes/0", "/media/volumes/1"]) {
        chownSync(root, 1000, 1000);
        chmodSync(root, 0o700);
      }
      mkdirSync("/deployment/bin", { mode: 0o755 });
      writeFileSync("/deployment/bin/docker", ${JSON.stringify('#!/usr/local/bin/node\nrequire("node:fs").appendFileSync("/deployment/docker.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n')}, { mode: 0o755 });
      writeFileSync("/deployment/config.env", "MEDIA_HOST_DIR=/media/volumes/0;/media/volumes/1\\n", { mode: 0o600 });
      chownSync("/deployment/config.env", 1000, 1000);
    `), "prepare fresh volumes for deployment UID 1000");

    succeeded(start(), "first start-compose as deployment UID 1000");
    succeeded(containerNode(0, `
      import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
      for (const volume of [0, 1]) {
        const root = "/media/volumes/" + volume;
        for (const name of [".incoming", ".quarantine", ".operations", "video", "video/ab"]) {
          const directory = root + "/" + name;
          mkdirSync(directory, { mode: 0o700 });
          chownSync(directory, 10001, 10001);
          chmodSync(directory, 0o700);
        }
        const media = root + "/video/ab/private.mp4";
        writeFileSync(media, "existing private media", { mode: 0o600 });
        chownSync(media, 10001, 10001);
      }
    `), "seed existing private API directories and media");
    const before = snapshot();

    // Keep the production service/image/command. Only replace its mounts with
    // named Linux volumes, avoiding Docker Desktop host-bind permission rules.
    composeUsed = true;
    succeeded(docker([...compose, "run", "--rm", "--no-deps", "media-init"]), "execute the production media-init service");
    succeeded(start(), "second start-compose as the same deployment UID 1000 after media-init");
    const after = snapshot();
    assert.deepEqual(after, before, "restart must preserve marker inode/mtime, private directories and media");
    for (const volume of after) {
      assert.deepEqual(volume.privateDirectories.map((directory) => directory.mode), [0o700, 0o700, 0o700]);
      assert.equal(volume.media.mode, 0o600);
    }

    succeeded(containerNode(1000, `
      import assert from "node:assert/strict";
      import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
      const calls = readFileSync("/deployment/docker.jsonl", "utf8").trim().split("\\n").map(JSON.parse);
      const expected = ["compose", "-f", "docker-compose.yml", "-f", "/deployment/compose.storage.generated.json", "--env-file", "/deployment/config.env", "up", "-d", "--build", "--wait"];
      assert.deepEqual(calls, [expected, expected], "both real start-compose runs must reach the Docker boundary");
      for (const volume of [0, 1]) {
        const root = "/media/volumes/" + volume;
        assert.equal(statSync(root).uid, 10001);
        assert.equal(statSync(root).gid, 10001);
        assert.deepEqual(JSON.parse(readFileSync(root + "/.movie-harbor-volume.json", "utf8")), { version: 1, volume });
        assert.throws(() => readdirSync(root), { code: "EACCES" }, "deployer only needs traversal, not volume enumeration");
        assert.throws(() => writeFileSync(root + "/unwanted-write", "no"), { code: "EACCES" });
        for (const name of [".incoming", ".quarantine", ".operations"]) {
          assert.throws(() => readdirSync(root + "/" + name), { code: "EACCES" });
        }
        assert.throws(() => readFileSync(root + "/video/ab/private.mp4"), { code: "EACCES" });
      }
      console.log("UID 1000: both Docker calls reached; markers readable; enumeration, writes and private files denied");
    `), "verify deployment UID access remains minimal");
    succeeded(containerNode(10001, `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
      for (const volume of [0, 1]) {
        const root = "/media/volumes/" + volume;
        assert.deepEqual(JSON.parse(readFileSync(root + "/.movie-harbor-volume.json", "utf8")), { version: 1, volume });
        assert.equal(readFileSync(root + "/video/ab/private.mp4", "utf8"), "existing private media");
        writeFileSync(root + "/.incoming/probe", "write probe", { mode: 0o600 });
        unlinkSync(root + "/.incoming/probe");
      }
    `), "verify API UID 10001 can still read markers and access private storage");
    t.diagnostic(`Linux UID 1000 → production media-init UID 0 → UID 1000 restart; ${JSON.stringify(after.map(({ marker }) => marker))}`);
  } finally {
    if (composeUsed) succeeded(docker([...compose, "down", "--remove-orphans"]), "remove isolated Compose network");
    for (const name of created) succeeded(docker(["volume", "rm", name]), "remove this test's isolated Linux volume");
    rmSync(root, { recursive: true, force: true });
  }
});
