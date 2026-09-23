import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedDefaults = {
  PUBLIC_ORIGIN: "http://localhost:8080",
  COOKIE_SECURE: "false",
  ALLOW_INSECURE_LAN_HTTP: "false",
  MAX_UPLOAD_BYTES: "53687091200",
};

function parseEnvExample() {
  return Object.fromEntries(
    readFileSync(path.join(projectRoot, ".env.example"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function composeConfig(environment = {}) {
  const cleanEnvironment = { ...process.env };
  for (const name of Object.keys(expectedDefaults)) {
    delete cleanEnvironment[name];
  }

  return JSON.parse(
    execFileSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...cleanEnvironment, ...environment },
      },
    ),
  );
}

function mountAt(config, service, target) {
  return config.services[service].volumes.find((mount) => mount.target === target);
}

test("declares the local deployment defaults in the root environment example", () => {
  const example = parseEnvExample();
  for (const [name, value] of Object.entries(expectedDefaults)) {
    assert.equal(example[name], value);
  }
});

test("README explains the local, trusted LAN, and HTTPS deployment boundaries", () => {
  const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");

  assert.match(readme, /ALLOW_INSECURE_LAN_HTTP/);
  assert.match(readme, /默认[^。\n]*false[^。\n]*localhost/);
  assert.match(readme, /http:\/\/192\.168\.1\.20:8080\/admin\//);
  assert.match(readme, /私有[^。\n]*数字 IP/);
  assert.match(readme, /localhost[^。\n]*分别登录/);
  assert.match(readme, /明文 HTTP[^。\n]*(受信任|可信)[^。\n]*局域网/);
  assert.match(readme, /(公网|公共网络|访客 Wi-Fi)[^。\n]*(不得|不要|禁用)/);
});

test("production Compose owns the same fallback expressions", () => {
  const source = readFileSync(path.join(projectRoot, "docker-compose.yml"), "utf8");
  assert.match(source, /PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:-http:\/\/localhost:8080\}/);
  assert.match(source, /COOKIE_SECURE: \$\{COOKIE_SECURE:-false\}/);
  assert.match(source, /ALLOW_INSECURE_LAN_HTTP: \$\{ALLOW_INSECURE_LAN_HTTP:-false\}/);
  assert.match(source, /MAX_UPLOAD_BYTES: \$\{MAX_UPLOAD_BYTES:-53687091200\}/);
});

test("production Compose resolves the local defaults for the API", () => {
  const environment = composeConfig().services.api.environment;
  for (const [name, value] of Object.entries(expectedDefaults)) {
    assert.equal(environment[name], value);
  }
});

test("explicit environment values override the production defaults", () => {
  const environment = composeConfig({
    PUBLIC_ORIGIN: "https://media.example.com",
    COOKIE_SECURE: "true",
    ALLOW_INSECURE_LAN_HTTP: "true",
    MAX_UPLOAD_BYTES: "1073741824",
  }).services.api.environment;
  assert.equal(environment.PUBLIC_ORIGIN, "https://media.example.com");
  assert.equal(environment.COOKIE_SECURE, "true");
  assert.equal(environment.ALLOW_INSECURE_LAN_HTTP, "true");
  assert.equal(environment.MAX_UPLOAD_BYTES, "1073741824");
});

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
