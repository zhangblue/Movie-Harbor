import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function composeConfig(environment = {}) {
  return JSON.parse(
    execFileSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, ...environment },
      },
    ),
  );
}

function mountAt(config, service, target) {
  return config.services[service].volumes.find((mount) => mount.target === target);
}

test("defaults PostgreSQL storage to a host data directory", () => {
  const config = composeConfig();
  const mount = mountAt(config, "postgres", "/var/lib/postgresql/data");

  assert.equal(mount.type, "bind");
  assert.equal(mount.source, path.join(projectRoot, "data/postgres"));
});

test("shares one writable media directory with read-only serving", () => {
  const config = composeConfig();
  const expected = path.join(projectRoot, "data/media");

  assert.equal(mountAt(config, "media-init", "/media").source, expected);
  assert.equal(mountAt(config, "api", "/media").source, expected);
  assert.equal(mountAt(config, "caddy", "/srv/media").source, expected);
  assert.equal(mountAt(config, "caddy", "/srv/media").read_only, true);
});

test("host storage directories can be overridden", () => {
  const config = composeConfig({
    DATABASE_HOST_DIR: "/tmp/movie-harbor-db-override",
    MEDIA_HOST_DIR: "/tmp/movie-harbor-media-override",
  });

  assert.equal(
    mountAt(config, "postgres", "/var/lib/postgresql/data").source,
    "/tmp/movie-harbor-db-override",
  );
  assert.equal(
    mountAt(config, "api", "/media").source,
    "/tmp/movie-harbor-media-override",
  );
});
