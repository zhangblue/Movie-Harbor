import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const safety = await import("./run-safety.mjs").catch(() => ({}));

function fixture() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "movie-harbor-e2e-safety-"));
  const generatedRoot = join(workspaceRoot, "tests", "e2e", ".generated");
  mkdirSync(generatedRoot, { recursive: true });
  return { workspaceRoot, generatedRoot };
}

test("a run owns two media volumes and overrides every inherited production storage path", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.buildE2EEnvironment, "function");
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));

  const first = safety.createE2ERun({ ...roots, runId: "a".repeat(32), ownerToken: "first-owner" });
  const second = safety.createE2ERun({ ...roots, runId: "b".repeat(32), ownerToken: "second-owner" });
  const environment = safety.buildE2EEnvironment(
    {
      MEDIA_HOST_DIR: "/production/data/media;/production/second-disk",
      DATABASE_HOST_DIR: "/production/data/postgres",
      E2E_COMPOSE_PROJECT: "production",
    },
    first,
  );

  assert.notEqual(first.project, second.project);
  assert.deepEqual(first.mediaDirs, [join(first.runDir, "media-0"), join(first.runDir, "media-1")]);
  assert.equal(first.mediaDirs.some((path) => second.mediaDirs.includes(path)), false);
  assert.notEqual(first.databaseDir, second.databaseDir);
  assert.equal(environment.MEDIA_HOST_DIR, first.mediaDirs.join(";"));
  assert.equal(environment.DATABASE_HOST_DIR, first.databaseDir);
  assert.equal(environment.E2E_COMPOSE_PROJECT, first.project);
  for (const directory of first.mediaDirs) assert.equal(resolve(directory), directory);
  assert.equal(resolve(first.databaseDir), first.databaseDir);
});

test("storage preparation initializes both identities and writes mounts only inside this run", (t) => {
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "1".repeat(32), ownerToken: "owner" });
  safety.prepareE2EStorage(run);
  for (const [volume, directory] of run.mediaDirs.entries()) {
    assert.deepEqual(JSON.parse(readFileSync(join(directory, ".movie-harbor-volume.json"))), { version: 1, volume });
  }
  const config = JSON.parse(readFileSync(run.composeOverride));
  assert.equal(config.services.api.environment.MEDIA_DIRS, "/media/volumes/0;/media/volumes/1");
  for (const service of ["api", "media-init", "caddy"]) {
    assert.deepEqual(config.services[service].volumes.map((mount) => [mount.source, mount.target, Boolean(mount.read_only), mount.bind.create_host_path]), [
      [join(run.runDir, "media-0"), service === "caddy" ? "/srv/media/volumes/0" : "/media/volumes/0", service === "caddy", false],
      [join(run.runDir, "media-1"), service === "caddy" ? "/srv/media/volumes/1" : "/media/volumes/1", service === "caddy", false],
    ]);
  }
});

test("cleanup preserves other runs and refuses a redirected or replaced second volume", (t) => {
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "2".repeat(32), ownerToken: "owner" });
  const other = safety.createE2ERun({ ...roots, runId: "3".repeat(32), ownerToken: "other" });
  const forged = { ...run, mediaDirs: [run.mediaDirs[0], other.mediaDirs[1]] };
  assert.throws(() => safety.buildBindCleanupPlan(forged, { uid: 501, gid: 20 }), /refusing E2E cleanup/);
  renameSync(run.mediaDirs[1], join(run.runDir, "original-volume-1"));
  mkdirSync(run.mediaDirs[1]);
  assert.throws(() => safety.buildBindCleanupPlan(run, { uid: 501, gid: 20 }), /identity changed/);
  assert.equal(existsSync(other.runDir), true);
  assert.equal(existsSync(join(run.runDir, "original-volume-1")), true);
});

test("E2E identities remain readable by the container UID under a restrictive host umask", (t) => {
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "6".repeat(32), ownerToken: "owner" });
  const previous = process.umask(0o077);
  try {
    safety.prepareE2EStorage(run);
  } finally {
    process.umask(previous);
  }
  for (const directory of run.mediaDirs) assert.notEqual(statSync(join(directory, ".movie-harbor-volume.json")).mode & 0o004, 0);
});

test("host cleanup can remove a prepared run before containers start, while preserving another run", (t) => {
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "4".repeat(32), ownerToken: "owner" });
  const other = safety.createE2ERun({ ...roots, runId: "5".repeat(32), ownerToken: "other" });
  safety.prepareE2EStorage(run);
  safety.cleanupE2ERun(run);
  assert.equal(existsSync(run.runDir), false);
  assert.equal(existsSync(other.runDir), true);
});

test("cleanup accepts only this run's marked directory under the generated runs root", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.cleanupE2ERun, "function");
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "c".repeat(32), ownerToken: "owned-run" });
  writeFileSync(join(run.runDir, "runner-file"), "runner");

  safety.cleanupE2ERun(run);

  assert.equal(existsSync(run.runDir), false);
  assert.equal(existsSync(roots.workspaceRoot), true);
});

test("container cleanup is planned without traversing inaccessible nonempty bind directories", (t) => {
  assert.equal(typeof safety.buildBindCleanupPlan, "function");
  const roots = fixture();
  const run = safety.createE2ERun({ ...roots, runId: "f".repeat(32), ownerToken: "owned-run" });
  t.after(() => {
    for (const directory of run.mediaDirs) if (existsSync(directory)) chmodSync(directory, 0o700);
    if (existsSync(run.databaseDir)) chmodSync(run.databaseDir, 0o700);
    rmSync(roots.workspaceRoot, { recursive: true, force: true });
  });
  writeFileSync(join(run.mediaDirs[1], "fixture.mp4"), "fixture");
  writeFileSync(join(run.databaseDir, "database-file"), "database");
  for (const directory of run.mediaDirs) chmodSync(directory, 0o000);
  chmodSync(run.databaseDir, 0o000);

  assert.throws(() => safety.cleanupE2ERun(run));
  assert.equal(existsSync(run.runDir), true);
  const plan = safety.buildBindCleanupPlan(run, { uid: 501, gid: 20 });

  assert.equal(plan.command, "docker");
  assert.deepEqual(plan.args.filter((arg) => arg.startsWith("type=bind,")), [
    `type=bind,source=${run.mediaDirs[0]},target=/e2e-media-0`,
    `type=bind,source=${run.mediaDirs[1]},target=/e2e-media-1`,
    `type=bind,source=${run.databaseDir},target=/e2e-database`,
  ]);
  assert.deepEqual(plan.args.slice(0, 10), [
    "run", "--rm", "--network", "none", "--read-only",
    "--security-opt", "no-new-privileges", "--user", "0:0", "--mount",
  ]);
  assert.match(plan.args.at(-1), /find \/e2e-media-0 -mindepth 1 -delete/);
  assert.match(plan.args.at(-1), /find \/e2e-media-1 -mindepth 1 -delete/);
  assert.match(plan.args.at(-1), /find \/e2e-database -mindepth 1 -delete/);
  assert.match(plan.args.at(-1), /chown 501:20 \/e2e-media-0 \/e2e-media-1 \/e2e-database/);
  assert.equal(plan.args.join(" ").includes(roots.workspaceRoot + "/data"), false);
  assert.throws(() => safety.buildBindCleanupPlan(run, { uid: -1, gid: 20 }), /non-negative integers/);
});

test("cleanup rejects empty, broad, production-default, external, unmarked, and replaced targets", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.cleanupE2ERun, "function");
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "d".repeat(32), ownerToken: "owned-run" });
  const productionMedia = join(roots.workspaceRoot, "data", "media");
  const productionDatabase = join(roots.workspaceRoot, "data", "postgres");
  const external = mkdtempSync(join(tmpdir(), "movie-harbor-e2e-external-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));

  for (const unsafe of ["", "/", roots.workspaceRoot, productionMedia, productionDatabase, external]) {
    assert.throws(() => safety.cleanupE2ERun({ ...run, runDir: unsafe }), /refusing E2E cleanup/);
  }
  assert.throws(
    () => safety.buildBindCleanupPlan({ ...run, mediaDirs: [productionMedia, run.mediaDirs[1]] }, { uid: 501, gid: 20 }),
    /refusing E2E cleanup/,
  );
  assert.throws(
    () => safety.buildBindCleanupPlan({ ...run, databaseDir: productionDatabase }, { uid: 501, gid: 20 }),
    /refusing E2E cleanup/,
  );

  rmSync(run.runDir, { recursive: true });
  mkdirSync(run.runDir, { recursive: true });
  mkdirSync(join(run.runDir, "media-0"));
  assert.throws(() => safety.cleanupE2ERun(run), /refusing E2E cleanup/);

  rmSync(run.runDir, { recursive: true });
  symlinkSync(external, run.runDir, "dir");
  assert.throws(() => safety.cleanupE2ERun(run), /refusing E2E cleanup/);
  assert.equal(existsSync(external), true);
});

test("creation rejects invalid ids and a symlinked generated root", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  const roots = fixture();
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
