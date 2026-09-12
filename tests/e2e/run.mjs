import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { buildE2EEnvironment, cleanupE2ERun, createE2ERun } from "./run-safety.mjs";

const root = resolve(import.meta.dirname, "../..");
const generated = resolve(import.meta.dirname, ".generated");
const runId = randomUUID().replaceAll("-", "");
const isolatedRun = createE2ERun({
  workspaceRoot: root,
  generatedRoot: generated,
  runId,
  ownerToken: randomUUID(),
  projectPrefix: process.env.E2E_COMPOSE_PROJECT ?? "mh-task15-e2e",
});
const project = isolatedRun.project;
const port = process.env.E2E_PORT ?? "18080";
const initialPassword = "task15-initial-password";
const changedPassword = "task15-changed-password";
const envFile = resolve(isolatedRun.runDir, "e2e.env");
const compose = ["compose", "-p", project, "--env-file", envFile, "-f", "docker-compose.yml"];
const runEnvironment = buildE2EEnvironment(process.env, isolatedRun);
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root,
  stdio: "inherit",
  env: runEnvironment,
  ...options,
});

async function assertPortAvailable() {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`E2E port ${port} is unavailable`, { cause: error })));
    server.listen(Number(port), "127.0.0.1", () => server.close(accept));
  });
}

const testEnv = {
  ...runEnvironment,
  E2E_BASE_URL: `http://127.0.0.1:${port}`,
  E2E_RUN_DIR: isolatedRun.runDir,
  E2E_ADMIN_NAME: "task15-admin",
  E2E_ADMIN_PASSWORD: initialPassword,
  E2E_CHANGED_PASSWORD: changedPassword,
};

try {
  writeFileSync(envFile, [
    `APP_PORT=${port}`,
    `MEDIA_HOST_DIR=${isolatedRun.mediaDir}`,
    `DATABASE_HOST_DIR=${isolatedRun.databaseDir}`,
    "POSTGRES_DB=movie_harbor",
    "POSTGRES_USER=movie_harbor",
    "POSTGRES_PASSWORD=task15-P@ss:/?%word",
    "ADMIN_NAME=task15-admin",
    `ADMIN_INITIAL_PASSWORD=${initialPassword}`,
    `PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
    "COOKIE_SECURE=false",
    "TRUST_PROXY_SECRET=task15-e2e-proxy-secret-at-least-32-bytes",
    "MAX_UPLOAD_BYTES=10485760",
    "VIDEO_MIME_ALLOWLIST=video/mp4,video/webm",
    "",
  ].join("\n"), { mode: 0o600 });

  const ffmpeg = spawnSync("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=32x32:d=0.4",
    "-an", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-y", resolve(isolatedRun.runDir, "sample.mp4"),
  ], { cwd: root, stdio: "inherit", env: runEnvironment });
  if (ffmpeg.error?.code === "ENOENT") throw new Error("ffmpeg is required to generate the tiny browser-playable E2E fixture");
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg fixture generation failed with exit code ${ffmpeg.status}`);

  run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  await assertPortAvailable();
  run("docker", [...compose, "up", "-d", "--build", "--wait"]);
  run("docker", [...compose, "exec", "-T", "--user", "10001", "api", "sh", "-c", "printf private > /media/.incoming/e2e-private-sentinel"]);
  run("npx", ["playwright", "test", "--project=admin"], { env: testEnv });
  run("docker", [...compose, "restart"]);
  run("docker", [...compose, "up", "-d", "--wait"]);
  run("npx", ["playwright", "test", "tests/e2e/persistence.spec.ts", "--project=persistence", "--no-deps"], { env: testEnv });
} finally {
  if (process.env.E2E_KEEP === "1") {
    console.error(`E2E_KEEP=1: kept project ${project}, run directory ${isolatedRun.runDir}, media directory ${isolatedRun.mediaDir}, and database directory ${isolatedRun.databaseDir}`);
  } else {
    try {
      run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
    } finally {
      cleanupE2ERun(isolatedRun);
    }
  }
}
