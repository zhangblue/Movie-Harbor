import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("rejects nested credentials, complete responses, and values with the wrong types on load and save", async (t) => {
  const path = await progressPath(t);
  const invalidMovies = [
    { id: { token: "secret" }, version: 1, metadataUpdated: true },
    { id: "movie-id", version: { headers: { cookie: "secret" } }, metadataUpdated: true },
    { id: "movie-id", version: 1, metadataUpdated: { response: { user: "admin" } } },
    { id: "movie-id", version: 1, metadataUpdated: true, response: { headers: { cookie: "secret" } } },
  ];
  for (const movie of invalidMovies) {
    const document = {
      formatVersion: 1, targetOrigin,
      source: sourceIdentity,
      genres: {}, movies: { Movie: movie }, series: {},
    };
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(openProgressStore({ path, targetOrigin, sourceIdentity }), /progress|unsupported/);
    const store = await openProgressStore({ path: join(dirname(path), "missing.json"), targetOrigin, sourceIdentity });
    store.state.movies.Movie = movie;
    await assert.rejects(store.save(), /progress|unsupported/);
  }

  const invalidSeries = {
    id: "series-id", version: 1, metadataUpdated: true,
    seasons: {
      "1": { id: "season-id", episodes: {
        "1": { id: "episode-id", version: 1, metadataUpdated: true, videoUploaded: true, completed: true, fullResponse: { cookie: "secret" } },
      } },
    },
  };
  const document = {
    formatVersion: 1, targetOrigin,
    source: sourceIdentity,
    genres: { Drama: { id: "genre-id", session: "secret" } }, movies: {}, series: { Show: invalidSeries },
  };
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(openProgressStore({ path, targetOrigin, sourceIdentity }), /progress|unsupported/);
  const store = await openProgressStore({ path: join(dirname(path), "another-missing.json"), targetOrigin, sourceIdentity });
  store.state.genres.Drama = { id: "genre-id", session: "secret" };
  store.state.series.Show = invalidSeries;
  await assert.rejects(store.save(), /progress|unsupported/);
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

test("chmod failure preserves the formal file and removes the temporary file", async (t) => {
  const path = await progressPath(t);
  const original = await openProgressStore({ path, targetOrigin, sourceIdentity });
  original.state.movies.Movie = { id: "old-id", version: 1, metadataUpdated: true };
  await original.save();
  const originalBytes = await readFile(path);
  const failingFs = {
    ...await import("node:fs/promises"),
    chmod: async () => { throw new Error("simulated chmod failure"); },
  };
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity, fs: failingFs });
  store.state.movies.Movie = { id: "new-id", version: 2, metadataUpdated: true };
  await assert.rejects(store.save(), /simulated chmod failure/);
  assert.deepEqual(await readFile(path), originalBytes);
  assert.deepEqual(await readdir(join(path, "..")), ["progress.json"]);
});
