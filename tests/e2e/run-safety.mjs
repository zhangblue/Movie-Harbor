import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ownerMarker = ".movie-harbor-e2e-owner";
const runIdPattern = /^[a-f0-9]{32}$/;
const projectPattern = /^mh-task15-e2e(?:-[a-z0-9-]+)?$/;

// 拒绝不满足所有权或路径约束的清理，避免删除非本次运行数据。
function refuse(reason) {
  throw new Error(`refusing E2E cleanup: ${reason}`);
}

// 验证目录存在且不是符号链接，供创建和清理隔离目录时使用。
function requireRealDirectory(path, message) {
  if (!existsSync(path)) throw new Error(message);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(message);
  return realpathSync(path);
}

// 读取目录设备号和 inode，供清理前检测目录被替换。
function directoryIdentity(path, message) {
  if (!existsSync(path)) throw new Error(message);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(message);
  return { dev: metadata.dev, ino: metadata.ino };
}

// 比较目录身份，供清理前确认 bind mount 未被替换。
function sameIdentity(actual, expected) {
  return actual.dev === expected?.dev && actual.ino === expected?.ino;
}

// 创建带所有权标记的独立运行目录、数据库和媒体目录，并生成独立 Compose 项目名。
export function createE2ERun({
  workspaceRoot,
  generatedRoot,
  runId,
  ownerToken,
  projectPrefix = "mh-task15-e2e",
}) {
  if (!runIdPattern.test(runId)) throw new Error("invalid E2E run id");
  if (!ownerToken || /[\r\n]/.test(ownerToken)) throw new Error("invalid E2E owner token");
  if (!projectPattern.test(projectPrefix)) throw new Error("invalid E2E compose project prefix");

  const requestedWorkspace = resolve(workspaceRoot);
  if (resolve(generatedRoot) !== resolve(requestedWorkspace, "tests", "e2e", ".generated")) {
    throw new Error("generated root must be the repository E2E .generated directory");
  }
  const workspace = requireRealDirectory(requestedWorkspace, "workspace root must be a real directory");
  const expectedGenerated = resolve(workspace, "tests", "e2e", ".generated");
  requireRealDirectory(dirname(expectedGenerated), "generated parent must be a real directory");
  if (!existsSync(expectedGenerated)) mkdirSync(expectedGenerated, { mode: 0o700 });
  const generated = requireRealDirectory(expectedGenerated, "generated root must be a real directory");
  if (generated !== expectedGenerated) throw new Error("generated root must be a real directory");

  const runsRoot = join(generated, "runs");
  if (!existsSync(runsRoot)) mkdirSync(runsRoot, { mode: 0o700 });
  if (requireRealDirectory(runsRoot, "runs root must be a real directory") !== runsRoot) {
    throw new Error("runs root must be a real directory");
  }

  const runDir = join(runsRoot, runId);
  if (existsSync(runDir)) throw new Error("E2E run directory already exists");
  mkdirSync(runDir, { mode: 0o700 });
  const mediaDir = join(runDir, "media");
  mkdirSync(mediaDir, { mode: 0o700 });
  const databaseDir = join(runDir, "postgres");
  mkdirSync(databaseDir, { mode: 0o700 });
  writeFileSync(
    join(runDir, ownerMarker),
    JSON.stringify({ runId, ownerToken }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  return {
    workspaceRoot: workspace,
    generatedRoot: generated,
    runsRoot,
    runId,
    ownerToken,
    runDir: realpathSync(runDir),
    mediaDir: realpathSync(mediaDir),
    mediaIdentity: directoryIdentity(mediaDir, "media directory must be a real directory"),
    databaseDir: realpathSync(databaseDir),
    databaseIdentity: directoryIdentity(databaseDir, "database directory must be a real directory"),
    project: `${projectPrefix}-${runId}`,
  };
}

// 清理或使用环境前复核路径、目录身份和所有权标记，任何异常均拒绝操作。
function verifyOwnedRun(run) {
  if (!run?.runDir || !run?.mediaDir) refuse("empty target");
  const workspace = requireRealDirectory(run.workspaceRoot, "workspace root must be a real directory");
  const expectedGenerated = resolve(workspace, "tests", "e2e", ".generated");
  if (run.generatedRoot !== expectedGenerated) refuse("generated root mismatch");
  if (requireRealDirectory(expectedGenerated, "generated root must be a real directory") !== expectedGenerated) refuse("generated root mismatch");
  const expectedRuns = join(expectedGenerated, "runs");
  if (run.runsRoot !== expectedRuns || requireRealDirectory(expectedRuns, "runs root must be a real directory") !== expectedRuns) refuse("runs root mismatch");
  if (!runIdPattern.test(run.runId)) refuse("invalid run id");
  const expectedRun = join(expectedRuns, run.runId);
  if (run.runDir !== expectedRun) refuse("run directory mismatch");
  if (requireRealDirectory(run.runDir, "run directory must be a real directory") !== expectedRun) refuse("run directory identity changed");
  const expectedMedia = join(expectedRun, "media");
  if (run.mediaDir !== expectedMedia) refuse("media directory mismatch");
  if (!sameIdentity(directoryIdentity(run.mediaDir, "media directory must be a real directory"), run.mediaIdentity)) refuse("media directory identity changed");
  const expectedDatabase = join(expectedRun, "postgres");
  if (run.databaseDir !== expectedDatabase) refuse("database directory mismatch");
  if (!sameIdentity(directoryIdentity(run.databaseDir, "database directory must be a real directory"), run.databaseIdentity)) refuse("database directory identity changed");

  const marker = join(expectedRun, ownerMarker);
  if (!existsSync(marker)) refuse("owner marker missing");
  const markerMetadata = lstatSync(marker);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) refuse("owner marker is not a regular file");
  let owner;
  try {
    owner = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    refuse("owner marker is invalid");
  }
  if (owner.runId !== run.runId || owner.ownerToken !== run.ownerToken) refuse("owner marker mismatch");
}

// 在确认目录归属后覆盖数据库和媒体路径，防止 E2E 使用生产数据。
export function buildE2EEnvironment(inherited, run) {
  verifyOwnedRun(run);
  return {
    ...inherited,
    MEDIA_HOST_DIR: run.mediaDir,
    DATABASE_HOST_DIR: run.databaseDir,
    E2E_COMPOSE_PROJECT: run.project,
  };
}

// 校验目录归属后生成隔离容器清理计划，处理容器拥有的文件并恢复目录权限。
export function buildBindCleanupPlan(run, { uid, gid }) {
  verifyOwnedRun(run);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("host uid and gid must be non-negative integers");
  }
  const cleanup = [
    "find /e2e-media -mindepth 1 -delete",
    "find /e2e-database -mindepth 1 -delete",
    `chown ${uid}:${gid} /e2e-media /e2e-database`,
    "chmod 0700 /e2e-media /e2e-database",
  ].join("\n");
  return {
    command: "docker",
    args: [
      "run", "--rm", "--network", "none", "--read-only",
      "--security-opt", "no-new-privileges", "--user", "0:0",
      "--mount", `type=bind,source=${run.mediaDir},target=/e2e-media`,
      "--mount", `type=bind,source=${run.databaseDir},target=/e2e-database`,
      "alpine:3.22", "sh", "-ec", cleanup,
    ],
  };
}

// 仅在身份匹配且 bind 目录已清空后删除本次运行目录。
export function cleanupE2ERun(run) {
  try {
    verifyOwnedRun(run);
    if (realpathSync(run.mediaDir) !== run.mediaDir || realpathSync(run.databaseDir) !== run.databaseDir) {
      refuse("bind directory identity changed");
    }
    if (readdirSync(run.mediaDir).length !== 0 || readdirSync(run.databaseDir).length !== 0) {
      refuse("bind directories must be empty before host cleanup");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing E2E cleanup:")) throw error;
    refuse(error instanceof Error ? error.message : "target validation failed");
  }
  rmSync(run.runDir, { recursive: true });
}
