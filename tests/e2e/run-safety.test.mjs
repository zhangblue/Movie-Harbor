import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// 缺少安全模块时保留空对象，让各契约断言明确报告所需能力缺失。
const safety = await import("./run-safety.mjs").catch(() => ({}));

// 创建隔离工作区与运行标识，供清理安全测试使用。
function fixture() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "movie-harbor-e2e-safety-"));
  const generatedRoot = join(workspaceRoot, "tests", "e2e", ".generated");
  mkdirSync(generatedRoot, { recursive: true });
  return { workspaceRoot, generatedRoot };
}

// 验证单次运行拥有独立项目、数据库和媒体目录并覆盖继承的存储配置。
test("a run owns a unique project, database, and media directory and overrides inherited storage configuration", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.buildE2EEnvironment, "function");
  const roots = fixture();
  // 测试结束时删除专属模拟工作区，避免残留目录影响其他安全用例。
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));

  const first = safety.createE2ERun({ ...roots, runId: "a".repeat(32), ownerToken: "first-owner" });
  const second = safety.createE2ERun({ ...roots, runId: "b".repeat(32), ownerToken: "second-owner" });
  const environment = safety.buildE2EEnvironment(
    {
      MEDIA_HOST_DIR: "/production/data/media",
      DATABASE_HOST_DIR: "/production/data/postgres",
      E2E_COMPOSE_PROJECT: "production",
    },
    first,
  );

  assert.notEqual(first.project, second.project);
  assert.notEqual(first.mediaDir, second.mediaDir);
  assert.notEqual(first.databaseDir, second.databaseDir);
  assert.equal(environment.MEDIA_HOST_DIR, first.mediaDir);
  assert.equal(environment.DATABASE_HOST_DIR, first.databaseDir);
  assert.equal(environment.E2E_COMPOSE_PROJECT, first.project);
  assert.equal(resolve(first.mediaDir), first.mediaDir);
  assert.equal(resolve(first.databaseDir), first.databaseDir);
});

// 验证清理只接受生成目录中带本次运行标记的目录。
test("cleanup accepts only this run's marked directory under the generated runs root", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.cleanupE2ERun, "function");
  const roots = fixture();
  // 测试结束时删除专属模拟工作区，避免残留目录影响其他安全用例。
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "c".repeat(32), ownerToken: "owned-run" });
  writeFileSync(join(run.runDir, "runner-file"), "runner");

  safety.cleanupE2ERun(run);

  assert.equal(existsSync(run.runDir), false);
  assert.equal(existsSync(roots.workspaceRoot), true);
});

// 验证生成容器清理计划时不遍历无法访问的非空挂载目录。
test("container cleanup is planned without traversing inaccessible nonempty bind directories", (t) => {
  assert.equal(typeof safety.buildBindCleanupPlan, "function");
  const roots = fixture();
  const run = safety.createE2ERun({ ...roots, runId: "f".repeat(32), ownerToken: "owned-run" });
  // 测试结束时恢复受限目录权限再清理，确保失败场景也可回收夹具。
  t.after(() => {
    if (existsSync(run.mediaDir)) chmodSync(run.mediaDir, 0o700);
    if (existsSync(run.databaseDir)) chmodSync(run.databaseDir, 0o700);
    rmSync(roots.workspaceRoot, { recursive: true, force: true });
  });
  writeFileSync(join(run.mediaDir, "fixture.mp4"), "fixture");
  writeFileSync(join(run.databaseDir, "database-file"), "database");
  chmodSync(run.mediaDir, 0o000);
  chmodSync(run.databaseDir, 0o000);

  assert.throws(() => safety.cleanupE2ERun(run));
  assert.equal(existsSync(run.runDir), true);
  const plan = safety.buildBindCleanupPlan(run, { uid: 501, gid: 20 });

  assert.equal(plan.command, "docker");
  assert.deepEqual(plan.args.filter((arg) => arg.startsWith("type=bind,")), [
    `type=bind,source=${run.mediaDir},target=/e2e-media`,
    `type=bind,source=${run.databaseDir},target=/e2e-database`,
  ]);
  assert.deepEqual(plan.args.slice(0, 10), [
    "run", "--rm", "--network", "none", "--read-only",
    "--security-opt", "no-new-privileges", "--user", "0:0", "--mount",
  ]);
  assert.match(plan.args.at(-1), /find \/e2e-media -mindepth 1 -delete/);
  assert.match(plan.args.at(-1), /find \/e2e-database -mindepth 1 -delete/);
  assert.match(plan.args.at(-1), /chown 501:20 \/e2e-media \/e2e-database/);
  assert.equal(plan.args.join(" ").includes(roots.workspaceRoot + "/data"), false);
  assert.throws(() => safety.buildBindCleanupPlan(run, { uid: -1, gid: 20 }), /non-negative integers/);
});

// 验证清理拒绝空值、宽泛路径、生产默认、外部、无标记和已替换目标。
test("cleanup rejects empty, broad, production-default, external, unmarked, and replaced targets", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.cleanupE2ERun, "function");
  const roots = fixture();
  // 测试结束时删除专属模拟工作区，避免残留目录影响其他安全用例。
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "d".repeat(32), ownerToken: "owned-run" });
  const productionMedia = join(roots.workspaceRoot, "data", "media");
  const productionDatabase = join(roots.workspaceRoot, "data", "postgres");
  const external = mkdtempSync(join(tmpdir(), "movie-harbor-e2e-external-"));
  // 测试结束时删除独立外部目录，避免安全用例留下数据。
  t.after(() => rmSync(external, { recursive: true, force: true }));

  for (const unsafe of ["", "/", roots.workspaceRoot, productionMedia, productionDatabase, external]) {
    assert.throws(() => safety.cleanupE2ERun({ ...run, runDir: unsafe }), /refusing E2E cleanup/);
  }
  assert.throws(
    () => safety.buildBindCleanupPlan({ ...run, mediaDir: productionMedia }, { uid: 501, gid: 20 }),
    /refusing E2E cleanup/,
  );
  assert.throws(
    () => safety.buildBindCleanupPlan({ ...run, databaseDir: productionDatabase }, { uid: 501, gid: 20 }),
    /refusing E2E cleanup/,
  );

  rmSync(run.runDir, { recursive: true });
  mkdirSync(run.runDir, { recursive: true });
  mkdirSync(join(run.runDir, "media"));
  assert.throws(() => safety.cleanupE2ERun(run), /refusing E2E cleanup/);

  rmSync(run.runDir, { recursive: true });
  symlinkSync(external, run.runDir, "dir");
  assert.throws(() => safety.cleanupE2ERun(run), /refusing E2E cleanup/);
  assert.equal(existsSync(external), true);
});

// 验证创建运行目录时拒绝无效标识和符号链接生成根目录。
test("creation rejects invalid ids and a symlinked generated root", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  const roots = fixture();
  // 测试结束时删除专属模拟工作区，避免残留目录影响其他安全用例。
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));

  assert.throws(
    () => safety.createE2ERun({ ...roots, runId: "../escape", ownerToken: "owner" }),
    /invalid E2E run id/,
  );

  const realGenerated = join(roots.workspaceRoot, "real-generated");
  mkdirSync(realGenerated);
  rmSync(roots.generatedRoot, { recursive: true });
  symlinkSync(realGenerated, roots.generatedRoot, "dir");
  assert.throws(
    () => safety.createE2ERun({ ...roots, runId: "e".repeat(32), ownerToken: "owner" }),
    /generated root must be a real directory/,
  );
});
