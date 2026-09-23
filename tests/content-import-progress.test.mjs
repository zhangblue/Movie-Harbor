import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProgressStore } from "../tools/content-import/progress.mjs";

const targetOrigin = "https://media.example.test";
const sourceIdentity = { exportedAt: "2026-09-24T00:00:00Z", sha256: "a".repeat(64) };

async function progressPath(t) {
  const directory = await mkdtemp(join(tmpdir(), "movie-harbor-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "progress.json");
}

test("creates an empty store bound to the target and source", async (t) => {
  const path = await progressPath(t);
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  assert.deepEqual(store.state, {
    formatVersion: 1, targetOrigin,
    source: sourceIdentity,
    genres: {}, movies: {}, series: {},
  });
});

test("persists successful state with private permissions", async (t) => {
  const path = await progressPath(t);
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  store.state.movies.Movie = { id: "movie-id", version: 2, metadataUpdated: true };
  await store.save();
  const restored = await openProgressStore({ path, targetOrigin, sourceIdentity });
  assert.deepEqual(restored.state.movies.Movie, store.state.movies.Movie);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("rejects progress belonging to a different target or source", async (t) => {
  const path = await progressPath(t);
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  await store.save();
  await assert.rejects(openProgressStore({ path, targetOrigin: "https://other.example.test", sourceIdentity }), /target origin/);
  await assert.rejects(openProgressStore({ path, targetOrigin, sourceIdentity: { ...sourceIdentity, sha256: "b".repeat(64) } }), /source identity/);
  await assert.rejects(openProgressStore({ path, targetOrigin, sourceIdentity: { ...sourceIdentity, exportedAt: "2026-09-23T00:00:00Z" } }), /source identity/);
});

test("rejects unsupported progress format versions", async (t) => {
  const path = await progressPath(t);
  await writeFile(path, JSON.stringify({ formatVersion: 2 }));
  await assert.rejects(openProgressStore({ path, targetOrigin, sourceIdentity }), /format version/);
});

test("does not persist authentication data or complete API responses", async (t) => {
  const path = await progressPath(t);
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  store.state.sessionCookie = "secret-cookie";
  await assert.rejects(store.save(), /unsupported progress field/);
});

test("cleans temporary files after a successful save", async (t) => {
  const path = await progressPath(t);
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  await store.save();
  assert.deepEqual(await readdir(join(path, "..")), ["progress.json"]);
});

test("rename failure preserves the formal file and removes only its temporary file", async (t) => {
  const path = await progressPath(t);
  const original = await openProgressStore({ path, targetOrigin, sourceIdentity });
  original.state.movies.Movie = { id: "old-id", version: 1, metadataUpdated: true };
  await original.save();
  const originalBytes = await readFile(path);
  const failingFs = {
    ...await import("node:fs/promises"),
    rename: async () => { throw new Error("simulated rename failure"); },
  };
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity, fs: failingFs });
  store.state.movies.Movie = { id: "new-id", version: 2, metadataUpdated: true };
  await assert.rejects(store.save(), /simulated rename failure/);
  assert.deepEqual(await readFile(path), originalBytes);
  assert.deepEqual(await readdir(join(path, "..")), ["progress.json"]);
});
