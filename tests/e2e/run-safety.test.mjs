import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a run owns a unique project, database, and media directory and overrides inherited storage configuration", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.buildE2EEnvironment, "function");
  const roots = fixture();
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

test("cleanup accepts only this run's marked directory under the generated runs root", (t) => {
  assert.equal(typeof safety.createE2ERun, "function");
  assert.equal(typeof safety.cleanupE2ERun, "function");
  const roots = fixture();
  t.after(() => rmSync(roots.workspaceRoot, { recursive: true, force: true }));
  const run = safety.createE2ERun({ ...roots, runId: "c".repeat(32), ownerToken: "owned-run" });
  writeFileSync(join(run.mediaDir, "fixture.mp4"), "fixture");
  writeFileSync(join(run.databaseDir, "database-file"), "database");

  safety.cleanupE2ERun(run);

  assert.equal(existsSync(run.runDir), false);
  assert.equal(existsSync(roots.workspaceRoot), true);
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

  rmSync(run.runDir, { recursive: true });
  mkdirSync(run.runDir, { recursive: true });
  mkdirSync(join(run.runDir, "media"));
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
