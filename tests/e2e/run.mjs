import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const generated = resolve(import.meta.dirname, ".generated");
const project = process.env.E2E_COMPOSE_PROJECT ?? "mh-task15-e2e";
if (!/^mh-task15-e2e(?:-[a-z0-9-]+)?$/.test(project)) {
  throw new Error("E2E_COMPOSE_PROJECT must start with mh-task15-e2e and contain only lowercase letters, numbers, and hyphens");
}
const port = process.env.E2E_PORT ?? "18080";
const initialPassword = "task15-initial-password";
const changedPassword = "task15-changed-password";
const envFile = resolve(generated, "e2e.env");
const compose = ["compose", "-p", project, "--env-file", envFile, "-f", "docker-compose.yml"];
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });

async function assertPortAvailable() {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`E2E port ${port} is unavailable`, { cause: error })));
    server.listen(Number(port), "127.0.0.1", () => server.close(accept));
  });
}

rmSync(generated, { recursive: true, force: true });
mkdirSync(generated, { recursive: true });
writeFileSync(envFile, [
  `APP_PORT=${port}`,
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
  "-movflags", "+faststart", "-y", resolve(generated, "sample.mp4"),
], { cwd: root, stdio: "inherit" });
if (ffmpeg.error?.code === "ENOENT") throw new Error("ffmpeg is required to generate the tiny browser-playable E2E fixture");
if (ffmpeg.status !== 0) throw new Error(`ffmpeg fixture generation failed with exit code ${ffmpeg.status}`);

const testEnv = {
  ...process.env,
  E2E_BASE_URL: `http://127.0.0.1:${port}`,
  E2E_COMPOSE_PROJECT: project,
  E2E_ADMIN_NAME: "task15-admin",
  E2E_ADMIN_PASSWORD: initialPassword,
  E2E_CHANGED_PASSWORD: changedPassword,
};

let cleanupEligible = false;
try {
  run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  cleanupEligible = true;
  await assertPortAvailable();
  run("docker", [...compose, "up", "-d", "--build", "--wait"]);
  run("docker", [...compose, "exec", "-T", "--user", "10001", "api", "sh", "-c", "printf private > /media/.incoming/e2e-private-sentinel"]);
  run("npx", ["playwright", "test", "--project=admin"], { env: testEnv });
  run("docker", [...compose, "restart"]);
  run("docker", [...compose, "up", "-d", "--wait"]);
  run("npx", ["playwright", "test", "tests/e2e/persistence.spec.ts", "--project=persistence", "--no-deps"], { env: testEnv });
} finally {
  if (cleanupEligible && process.env.E2E_KEEP !== "1") run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
}
