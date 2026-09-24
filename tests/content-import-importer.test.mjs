import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImportRequestError } from "../tools/content-import/client.mjs";
import { importContent } from "../tools/content-import/importer.mjs";
import { openProgressStore } from "../tools/content-import/progress.mjs";

const identity = { exportedAt: "2026-09-24T00:00:00Z", sha256: "a".repeat(64) };
const timestamp = "2026-09-24T00:00:00Z";
const source = (movies = [], series = []) => ({ identity, movies, series });
const movie = (name, overrides = {}) => ({ name, synopsis: `${name} synopsis`, year: 2024, durationSeconds: 100, genres: [], poster: null, video: null, ...overrides });
const genre = (name, id, enabled = true) => ({ id, name, sort_order: 10, enabled });
const listItem = (name, kind, id = `${kind}-${name}`) => ({ id, kind, name, status: "draft", version: 1, created_at: timestamp, poster_url: null });
const media = (id, slot) => ({ id: `${id}-${slot}`, url: `/media/${id}-${slot}`, local_path: `/media/${id}-${slot}`,
  original_name: `${slot}.${slot === "poster" ? "png" : "mp4"}`, mime_type: slot === "poster" ? "image/png" : "video/mp4", byte_size: 8 });
function movieResponse(name, id, version = 1, fields = {}) {
  return { id, name, synopsis: "", year: null, duration_seconds: null, status: "draft", version,
    published_at: null, archived_at: null, created_at: timestamp, updated_at: timestamp,
    genres: [], poster: null, video: null, ...fields };
}
function fakeClient({ genres = [], existingMovies = [], existingSeries = [], failure } = {}) {
  const calls = [];
  const records = new Map();
  const genreRecords = [...genres];
  let next = 1;
  const client = {
    calls,
    records,
    async json(method, path, body) {
      calls.push({ method, path, body });
      const injected = failure?.({ method, path, body, calls, records, genres: genreRecords });
      if (injected) throw injected;
      if (method === "GET" && path === "/api/admin/genres") return genreRecords.map((item) => ({ ...item }));
      if (method === "POST" && path === "/api/admin/genres") {
        const created = genre(body.name, `genre-${next++}`);
        genreRecords.push(created);
        return { ...created };
      }
      const contentMatch = /^\/api\/admin\/contents\?kind=(movie|series)&page=(\d+)$/.exec(path);
      if (method === "GET" && contentMatch) {
        const [, kind, pageText] = contentMatch;
        const all = kind === "movie" ? existingMovies : existingSeries;
        const page = Number(pageText);
        return { page, size: 20, total: all.length, items: all.slice((page - 1) * 20, page * 20) };
      }
      if (method === "POST" && path === "/api/admin/movies") {
        const created = movieResponse(body.name, `new-movie-${next++}`);
        records.set(created.id, created);
        return { ...created };
      }
      const movieMatch = /^\/api\/admin\/movies\/([^/]+)$/.exec(path);
      if (movieMatch && method === "GET") {
        const found = records.get(movieMatch[1]);
        if (!found) throw new ImportRequestError("missing", { status: 404 });
        return { ...found };
      }
      if (movieMatch && method === "PATCH") {
        const current = records.get(movieMatch[1]);
        assert.equal(body.version, current.version);
        const updated = { ...current, name: body.name, synopsis: body.synopsis, year: body.year,
          duration_seconds: body.duration_seconds, genres: body.genre_ids.map((id) => {
            const match = genreRecords.find((entry) => entry.id === id);
            return { id, name: match.name, enabled: match.enabled };
          }), version: current.version + 1 };
        records.set(updated.id, updated);
        return { ...updated };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async upload(path, file) {
      calls.push({ method: "UPLOAD", path, file });
      const injected = failure?.({ method: "UPLOAD", path, file, calls, records, genres: genreRecords });
      if (injected) throw injected;
      const match = /^\/api\/admin\/media\/movies\/([^/]+)\/(poster|video)\?version=(\d+)$/.exec(path);
      if (!match) throw new Error(`unexpected UPLOAD ${path}`);
      const [, id, slot, versionText] = match;
      const current = records.get(id);
      assert.equal(Number(versionText), current.version);
      const asset = media(id, slot);
      records.set(id, { ...current, [slot]: asset, version: current.version + 1 });
      return { id: asset.id, original_name: file.fileName, mime_type: slot === "poster" ? "image/png" : "video/mp4", byte_size: file.byteSize, version: current.version + 1 };
    },
  };
  return client;
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "mh-importer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "progress.json");
  const progress = await openProgressStore({ path, targetOrigin: "https://target.example.test", sourceIdentity: identity });
  const messages = [];
  const logger = { info: (message) => messages.push(["info", message]), warn: (message) => messages.push(["warn", message]), error: (message) => messages.push(["error", message]) };
  return { path, progress, messages, logger };
}

test("reuses enabled genres, creates missing genres, and skips only same-kind conflicts", async (t) => {
  const { path, progress, logger, messages } = await setup(t);
  const client = fakeClient({ genres: [genre("剧情", "genre-drama")], existingMovies: [listItem("Existing", "movie")], existingSeries: [listItem("New", "series")] });
  const result = await importContent({ source: source([movie("Existing", { genres: ["剧情"] }), movie("New", { genres: ["自定义"] })]), client, progress, logger });
  assert.deepEqual(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/genres").map((call) => call.body), [{ name: "自定义" }]);
  assert.deepEqual(result.skipped, [{ kind: "movie", name: "Existing" }]);
  assert.deepEqual(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/movies").map((call) => call.body), [{ name: "New" }]);
  assert.deepEqual(client.calls.filter((call) => call.path.startsWith("/api/admin/contents?")).map((call) => call.path), ["/api/admin/contents?kind=movie&page=1", "/api/admin/contents?kind=series&page=1"]);
  assert.equal(progress.state.genres["剧情"], "genre-drama");
  assert.equal(progress.state.genres["自定义"], "genre-1");
  assert.equal(JSON.parse(await readFile(path, "utf8")).genres["自定义"], "genre-1");
  assert.ok(messages.some(([, message]) => message.includes("SKIP") && message.includes("Existing")));
  assert.equal(result.failed.length, 0);
});

test("re-reads a genre after create conflict and accepts only an enabled exact name", async (t) => {
  const { progress, logger } = await setup(t);
  let conflict = true;
  const client = fakeClient({ failure({ method, path, body, genres }) {
    if (conflict && method === "POST" && path === "/api/admin/genres") {
      conflict = false;
      genres.push(genre(body.name, "raced-id"));
      return new ImportRequestError("conflict", { status: 409 });
    }
  } });
  await importContent({ source: source([movie("New", { genres: ["自定义"] })]), client, progress, logger });
  assert.equal(progress.state.genres["自定义"], "raced-id");
  assert.deepEqual(client.calls.filter((call) => call.path === "/api/admin/genres").map((call) => call.method), ["GET", "POST", "GET"]);
  assert.deepEqual(client.calls.find((call) => call.method === "PATCH").body.genre_ids, ["raced-id"]);
});

test("disabled exact genre stops before content writes", async (t) => {
  const { progress, logger } = await setup(t);
  const client = fakeClient({ genres: [genre("剧情", "disabled", false)] });
  await assert.rejects(importContent({ source: source([movie("New", { genres: ["剧情"] })]), client, progress, logger }), /disabled|停用/i);
  assert.deepEqual(client.calls.map((call) => call.path), ["/api/admin/genres"]);
});

test("conflict index reads every page and skips an external match on a later page", async (t) => {
  const { progress, logger } = await setup(t);
  const client = fakeClient({ existingMovies: [...Array.from({ length: 20 }, (_, index) => listItem(`Other ${index}`, "movie")), listItem("Later", "movie")] });
  const result = await importContent({ source: source([movie("Later")]), client, progress, logger });
  assert.deepEqual(result.skipped, [{ kind: "movie", name: "Later" }]);
  assert.deepEqual(client.calls.filter((call) => call.path.includes("kind=movie")).map((call) => call.path), ["/api/admin/contents?kind=movie&page=1", "/api/admin/contents?kind=movie&page=2"]);
  assert.equal(client.calls.filter((call) => call.path === "/api/admin/movies").length, 0);
});

test("movie create, metadata, poster and video save each returned version; rerun does not duplicate", async (t) => {
  const { path, progress, logger } = await setup(t);
  const poster = { localPath: "/safe/poster.png", fileName: "poster.png", byteSize: 8 };
  const video = { localPath: "/safe/movie.mp4", fileName: "movie.mp4", byteSize: 12 };
  const client = fakeClient();
  const input = source([movie("Film", { poster, video })]);
  const first = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(client.calls.filter((call) => ["POST", "PATCH", "UPLOAD"].includes(call.method) && call.path !== "/api/admin/genres").map((call) => [call.method, call.path]), [
    ["POST", "/api/admin/movies"], ["PATCH", "/api/admin/movies/new-movie-1"],
    ["UPLOAD", "/api/admin/media/movies/new-movie-1/poster?version=2"],
    ["UPLOAD", "/api/admin/media/movies/new-movie-1/video?version=3"],
  ]);
  assert.deepEqual(progress.state.movies.Film, { id: "new-movie-1", version: 4, metadataUpdated: true, posterUploaded: true, videoUploaded: true, completed: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).movies.Film, progress.state.movies.Film);
  assert.deepEqual(first.completed, [{ kind: "movie", name: "Film" }]);
  await importContent({ source: input, client, progress, logger });
  assert.equal(client.calls.filter((call) => call.path === "/api/admin/movies").length, 1);
  assert.equal(client.calls.filter((call) => call.method === "UPLOAD").length, 2);
});

test("a failed movie video resumes without repeating create, metadata or poster", async (t) => {
  const { path, progress, logger } = await setup(t);
  let fail = true;
  const client = fakeClient({ failure({ method, path }) {
    if (fail && method === "UPLOAD" && path.includes("/video?")) {
      fail = false;
      return new ImportRequestError("connection lost", { fatal: true, category: "network" });
    }
  } });
  const input = source([movie("Film", { poster: { localPath: "/safe/p.png", fileName: "p.png", byteSize: 8 }, video: { localPath: "/safe/v.mp4", fileName: "v.mp4", byteSize: 12 } })]);
  await assert.rejects(importContent({ source: input, client, progress, logger }), /connection lost/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).movies.Film, { id: "new-movie-1", version: 3, metadataUpdated: true, posterUploaded: true });
  const second = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(second.resumed, [{ kind: "movie", name: "Film" }]);
  assert.deepEqual(client.calls.filter((call) => call.path === "/api/admin/movies").length, 1);
  assert.equal(client.calls.filter((call) => call.path.includes("/poster?")).length, 1);
  assert.equal(client.calls.filter((call) => call.path.includes("/video?")).length, 2);
  assert.equal(client.calls.filter((call) => call.method === "GET" && call.path === "/api/admin/movies/new-movie-1").length, 1);
});

test("ordinary movie failure continues to the next item and leaves failed step unsaved", async (t) => {
  const { path, progress, logger, messages } = await setup(t);
  const client = fakeClient({ failure({ method, path }) {
    if (method === "PATCH" && path === "/api/admin/movies/new-movie-1") return new ImportRequestError("invalid metadata", { status: 422 });
  } });
  const result = await importContent({ source: source([movie("Bad"), movie("Good")]), client, progress, logger });
  assert.deepEqual(result.failed, [{ kind: "movie", name: "Bad", error: "invalid metadata" }]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).movies.Bad, { id: "new-movie-1", version: 1 });
  assert.equal(progress.state.movies.Good.completed, true);
  assert.ok(messages.some(([, message]) => message.includes("FAILED") && message.includes("Bad")));
});

test("missing or changed resume targets fail only the affected movie", async (t) => {
  for (const scenario of ["missing", "changed"]) {
    await t.test(scenario, async (nested) => {
      const { progress, logger } = await setup(nested);
      progress.state.movies.Stale = { id: "old-id", version: 2, metadataUpdated: true };
      await progress.save();
      const client = fakeClient();
      if (scenario === "changed") client.records.set("old-id", movieResponse("Stale", "old-id", 3));
      const result = await importContent({ source: source([movie("Stale"), movie("Next")]), client, progress, logger });
      assert.deepEqual(result.failed.map(({ name }) => name), ["Stale"]);
      assert.equal(progress.state.movies.Next.completed, true);
      assert.equal(client.calls.filter((call) => call.path === "/api/admin/movies").length, 1);
      assert.equal(client.calls.filter((call) => call.method === "PATCH" && call.path === "/api/admin/movies/old-id").length, 0);
    });
  }
});

test("a completed checkpoint still reports a deleted target and continues", async (t) => {
  const { progress, logger } = await setup(t);
  progress.state.movies.Gone = { id: "gone-id", version: 4, metadataUpdated: true, completed: true };
  await progress.save();
  const client = fakeClient({ existingMovies: [listItem("Gone", "movie", "gone-id")] });
  const result = await importContent({ source: source([movie("Gone"), movie("Next")]), client, progress, logger });
  assert.deepEqual(result.failed.map(({ name }) => name), ["Gone"]);
  assert.equal(progress.state.movies.Next.completed, true);
  assert.equal(client.calls.filter((call) => call.method === "GET" && call.path === "/api/admin/movies/gone-id").length, 1);
});

test("auth failure stops immediately and does not persist an incomplete genre", async (t) => {
  const { path, progress, logger } = await setup(t);
  const client = fakeClient({ failure({ method, path }) {
    if (method === "POST" && path === "/api/admin/genres") return new ImportRequestError("unauthorized", { fatal: true, category: "auth", status: 401 });
  } });
  await assert.rejects(importContent({ source: source([movie("Film", { genres: ["New"] })]), client, progress, logger }), /unauthorized/);
  assert.deepEqual(progress.state.genres, {});
  assert.equal(client.calls.filter((call) => call.path === "/api/admin/movies").length, 0);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("a __proto__ genre is stored as an own progress entry and reused on rerun", async (t) => {
  const { path, progress, logger } = await setup(t);
  const client = fakeClient();
  const input = source([movie("Film", { genres: ["__proto__"] })]);
  const first = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(first.completed, [{ kind: "movie", name: "Film" }]);
  assert.deepEqual(client.calls.filter((call) => call.path === "/api/admin/genres").map((call) => [call.method, call.body]), [
    ["GET", undefined], ["POST", { name: "__proto__" }],
  ]);
  assert.deepEqual(client.calls.find((call) => call.method === "PATCH").body.genre_ids, ["genre-1"]);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(saved.genres, "__proto__"), true);
  assert.equal(saved.genres["__proto__"], "genre-1");
  assert.equal(Object.getPrototypeOf(progress.state.genres), Object.prototype);
  await importContent({ source: input, client, progress, logger });
  assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/genres").length, 1);
  assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/movies").length, 1);
});

test("constructor and toString movie names create own checkpoints and resume without duplicates", async (t) => {
  const { path, progress, logger } = await setup(t);
  let failVideo = true;
  const client = fakeClient({ failure({ method, path }) {
    if (failVideo && method === "UPLOAD" && path.includes("/video?")) {
      failVideo = false;
      return new ImportRequestError("connection lost", { fatal: true, category: "network" });
    }
  } });
  const input = source([
    movie("constructor", { video: { localPath: "/safe/one.mp4", fileName: "one.mp4", byteSize: 12 } }),
    movie("toString"),
  ]);
  await assert.rejects(importContent({ source: input, client, progress, logger }), /connection lost/);
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(checkpoint.movies, "constructor"), true);
  assert.deepEqual(checkpoint.movies.constructor, { id: "new-movie-1", version: 2, metadataUpdated: true });
  const second = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(second.resumed, [{ kind: "movie", name: "constructor" }]);
  assert.deepEqual(second.completed, [{ kind: "movie", name: "toString" }]);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(saved.movies, "constructor"), true);
  assert.equal(Object.hasOwn(saved.movies, "toString"), true);
  assert.equal(saved.movies.constructor.completed, true);
  assert.equal(saved.movies.toString.completed, true);
  assert.equal(Object.getPrototypeOf(progress.state.movies), Object.prototype);
  await importContent({ source: input, client, progress, logger });
  assert.deepEqual(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/movies").map((call) => call.body), [{ name: "constructor" }, { name: "toString" }]);
  assert.deepEqual(client.calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/admin/movies/")).map((call) => call.path), [
    "/api/admin/movies/new-movie-1", "/api/admin/movies/new-movie-1", "/api/admin/movies/new-movie-2",
  ]);
});
