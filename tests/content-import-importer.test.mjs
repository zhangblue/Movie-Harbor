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
const series = (name, episodes = [], overrides = {}) => ({ name, synopsis: `${name} synopsis`, year: 2024, genres: [], poster: null, episodes, ...overrides });
const episode = (seasonNumber, episodeNumber, overrides = {}) => ({ seasonNumber, episodeNumber, name: `Episode ${episodeNumber}`, durationSeconds: 45, video: null, ...overrides });
const genre = (name, id, enabled = true) => ({ id, name, sort_order: 10, enabled });
const listItem = (name, kind, id = `${kind}-${name}`) => ({ id, kind, name, status: "draft", version: 1, created_at: timestamp, poster_url: null });
const media = (id, slot) => ({ id: `${id}-${slot}`, url: `/media/${id}-${slot}`, local_path: `/media/${id}-${slot}`,
  original_name: `${slot}.${slot === "poster" ? "png" : "mp4"}`, mime_type: slot === "poster" ? "image/png" : "video/mp4", byte_size: 8 });
function movieResponse(name, id, version = 1, fields = {}) {
  return { id, name, synopsis: "", year: null, duration_seconds: null, status: "draft", version,
    published_at: null, archived_at: null, created_at: timestamp, updated_at: timestamp,
    genres: [], poster: null, video: null, ...fields };
}
function seriesResponse(name, id, version = 1, fields = {}) {
  return { id, name, synopsis: "", year: null, status: "draft", version,
    published_at: null, archived_at: null, created_at: timestamp, updated_at: timestamp,
    genres: [], poster: null, seasons: [], ...fields };
}
function snapshot(value) { return structuredClone(value); }
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
      if (method === "POST" && path === "/api/admin/series") {
        const created = seriesResponse(body.name, `new-series-${next++}`);
        records.set(created.id, created);
        return snapshot(created);
      }
      const seriesMatch = /^\/api\/admin\/series\/([^/]+)$/.exec(path);
      if (seriesMatch && method === "GET") {
        const found = records.get(seriesMatch[1]);
        if (!found) throw new ImportRequestError("missing", { status: 404 });
        return snapshot(found);
      }
      if (seriesMatch && method === "PATCH") {
        const current = records.get(seriesMatch[1]);
        assert.equal(body.version, current.version);
        const updated = { ...current, name: body.name, synopsis: body.synopsis, year: body.year,
          genres: body.genre_ids.map((id) => ({ id, name: genreRecords.find((entry) => entry.id === id).name, enabled: true })),
          version: current.version + 1 };
        records.set(updated.id, updated);
        return snapshot(updated);
      }
      const seasonMatch = /^\/api\/admin\/series\/([^/]+)\/seasons$/.exec(path);
      if (seasonMatch && method === "POST") {
        const current = records.get(seasonMatch[1]);
        assert.equal(body.version, current.version);
        const updated = { ...current, version: current.version + 1,
          seasons: [...current.seasons, { id: `season-${next++}`, number: body.number, episodes: [] }] };
        records.set(updated.id, updated);
        return snapshot(updated);
      }
      const episodeCreateMatch = /^\/api\/admin\/series\/([^/]+)\/seasons\/([^/]+)\/episodes$/.exec(path);
      if (episodeCreateMatch && method === "POST") {
        const current = records.get(episodeCreateMatch[1]);
        assert.equal(body.version, current.version);
        const season = current.seasons.find((item) => item.id === episodeCreateMatch[2]);
        assert.ok(season);
        season.episodes.push({ id: `episode-${next++}`, season_id: season.id, number: body.number,
          name: body.name, duration_seconds: null, status: "draft", version: 1,
          published_at: null, archived_at: null, created_at: timestamp, updated_at: timestamp, video: null });
        current.version += 1;
        return snapshot(current);
      }
      const episodeMatch = /^\/api\/admin\/series\/([^/]+)\/seasons\/([^/]+)\/episodes\/([^/]+)$/.exec(path);
      if (episodeMatch && method === "PATCH") {
        const current = records.get(episodeMatch[1]);
        const item = current.seasons.find((season) => season.id === episodeMatch[2])?.episodes.find((entry) => entry.id === episodeMatch[3]);
        assert.ok(item);
        assert.equal(body.version, item.version);
        assert.equal(Object.hasOwn(body, "duration_seconds"), true);
        item.duration_seconds = body.duration_seconds;
        item.version += 1;
        current.version += 1;
        return { series_version: current.version, episode: snapshot(item) };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async upload(path, file) {
      calls.push({ method: "UPLOAD", path, file });
      const injected = failure?.({ method: "UPLOAD", path, file, calls, records, genres: genreRecords });
      if (injected) throw injected;
      const match = /^\/api\/admin\/media\/movies\/([^/]+)\/(poster|video)\?version=(\d+)$/.exec(path);
      const seriesPoster = /^\/api\/admin\/media\/series\/([^/]+)\/poster\?version=(\d+)$/.exec(path);
      if (seriesPoster) {
        const [, id, versionText] = seriesPoster;
        const current = records.get(id);
        assert.equal(Number(versionText), current.version);
        current.poster = media(id, "poster");
        current.version += 1;
        return { id: current.poster.id, original_name: file.fileName, mime_type: "image/png", byte_size: file.byteSize, version: current.version };
      }
      const episodeVideo = /^\/api\/admin\/media\/episodes\/([^/]+)\/video\?version=(\d+)$/.exec(path);
      if (episodeVideo) {
        const current = [...records.values()].find((entry) => entry.seasons?.some((season) => season.episodes.some((item) => item.id === episodeVideo[1])));
        const item = current?.seasons.flatMap((season) => season.episodes).find((entry) => entry.id === episodeVideo[1]);
        assert.ok(item);
        assert.equal(Number(episodeVideo[2]), item.version);
        item.video = media(item.id, "video");
        item.version += 1;
        current.version += 1;
        return { id: item.video.id, original_name: file.fileName, mime_type: "video/mp4", byte_size: file.byteSize,
          version: item.version, series_version: current.version };
      }
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

test("series imports sorted seasons and episodes with returned parent and child versions", async (t) => {
  const { path, progress, logger } = await setup(t);
  const video = { localPath: "/safe/episode.mp4", fileName: "episode.mp4", byteSize: 12 };
  const poster = { localPath: "/safe/series.png", fileName: "series.png", byteSize: 8 };
  const input = source([], [series("Show", [episode(2, 1), episode(1, 2, { durationSeconds: null }), episode(1, 1, { video })], { poster })]);
  const client = fakeClient();
  const result = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(result.completed, [{ kind: "series", name: "Show" }]);
  assert.deepEqual(client.calls.filter((call) => ["POST", "PATCH", "UPLOAD"].includes(call.method) && call.path !== "/api/admin/genres")
    .map(({ method, path, body }) => [method, path, body]), [
    ["POST", "/api/admin/series", { name: "Show" }],
    ["PATCH", "/api/admin/series/new-series-1", { version: 1, name: "Show", synopsis: "Show synopsis", year: 2024, genre_ids: [] }],
    ["UPLOAD", "/api/admin/media/series/new-series-1/poster?version=2", undefined],
    ["POST", "/api/admin/series/new-series-1/seasons", { version: 3, number: 1 }],
    ["POST", "/api/admin/series/new-series-1/seasons/season-2/episodes", { version: 4, number: 1, name: "Episode 1" }],
    ["PATCH", "/api/admin/series/new-series-1/seasons/season-2/episodes/episode-3", { version: 1, duration_seconds: 45 }],
    ["UPLOAD", "/api/admin/media/episodes/episode-3/video?version=2", undefined],
    ["POST", "/api/admin/series/new-series-1/seasons/season-2/episodes", { version: 7, number: 2, name: "Episode 2" }],
    ["PATCH", "/api/admin/series/new-series-1/seasons/season-2/episodes/episode-4", { version: 1, duration_seconds: null }],
    ["POST", "/api/admin/series/new-series-1/seasons", { version: 9, number: 2 }],
    ["POST", "/api/admin/series/new-series-1/seasons/season-5/episodes", { version: 10, number: 1, name: "Episode 1" }],
    ["PATCH", "/api/admin/series/new-series-1/seasons/season-5/episodes/episode-6", { version: 1, duration_seconds: 45 }],
  ]);
  assert.deepEqual(progress.state.series.Show, { id: "new-series-1", version: 12, metadataUpdated: true, posterUploaded: true,
    seasons: { 1: { id: "season-2", episodes: {
      1: { id: "episode-3", version: 3, metadataUpdated: true, videoUploaded: true, completed: true },
      2: { id: "episode-4", version: 2, metadataUpdated: true, completed: true },
    } }, 2: { id: "season-5", episodes: { 1: { id: "episode-6", version: 2, metadataUpdated: true, completed: true } } } }, completed: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).series.Show, progress.state.series.Show);
  await importContent({ source: input, client, progress, logger });
  assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/series").length, 1);
});

test("series resumes each interrupted hierarchy step without repeating saved writes", async (t) => {
  const video = { localPath: "/safe/episode.mp4", fileName: "episode.mp4", byteSize: 12 };
  const steps = [
    ["season", ({ method, path }) => method === "POST" && path.endsWith("/seasons")],
    ["episode", ({ method, path }) => method === "POST" && path.endsWith("/episodes")],
    ["duration", ({ method, path }) => method === "PATCH" && path.includes("/episodes/")],
    ["video", ({ method, path }) => method === "UPLOAD" && path.includes("/episodes/")],
  ];
  for (const [label, matches] of steps) {
    await t.test(label, async (nested) => {
      const { path, progress, logger } = await setup(nested);
      let interrupted = false;
      const client = fakeClient({ failure(call) {
        if (!interrupted && matches(call)) {
          interrupted = true;
          return new ImportRequestError("connection lost", { fatal: true, category: "network" });
        }
      } });
      const input = source([], [series("Show", [episode(1, 1, { video })])]);
      await assert.rejects(importContent({ source: input, client, progress, logger }), /connection lost/);
      const checkpoint = JSON.parse(await readFile(path, "utf8")).series.Show;
      assert.equal(checkpoint.version, ({ season: 2, episode: 3, duration: 4, video: 5 })[label]);
      const second = await importContent({ source: input, client, progress, logger });
      assert.deepEqual(second.resumed, [{ kind: "series", name: "Show" }]);
      assert.equal(progress.state.series.Show.completed, true);
      assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/series").length, 1);
      assert.equal(client.calls.filter((call) => matches(call)).length, 2);
      assert.equal(client.calls.filter((call) => call.method === "POST" && call.path.endsWith("/seasons")).length, label === "season" ? 2 : 1);
      assert.equal(client.calls.filter((call) => call.method === "POST" && call.path.endsWith("/episodes")).length, label === "episode" ? 2 : 1);
    });
  }
});

test("series resume rejects missing, changed and non-draft hierarchy before writing", async (t) => {
  for (const scenario of ["missing", "parent-version", "parent-status", "season-id", "episode-id", "episode-version", "episode-status"]) {
    await t.test(scenario, async (nested) => {
      const { progress, logger } = await setup(nested);
      const input = source([], [series("Stale", [episode(1, 1)]), series("Next")]);
      const client = fakeClient();
      await importContent({ source: source([], [input.series[0]]), client, progress, logger });
      const stale = progress.state.series.Stale;
      const target = client.records.get(stale.id);
      if (scenario === "missing") client.records.delete(stale.id);
      if (scenario === "parent-version") target.version += 1;
      if (scenario === "parent-status") target.status = "published";
      if (scenario === "season-id") target.seasons[0].id = "other-season";
      if (scenario === "episode-id") target.seasons[0].episodes[0].id = "other-episode";
      if (scenario === "episode-version") target.seasons[0].episodes[0].version += 1;
      if (scenario === "episode-status") target.seasons[0].episodes[0].status = "published";
      const priorWrites = client.calls.filter((call) => ["POST", "PATCH", "UPLOAD"].includes(call.method)).length;
      const result = await importContent({ source: input, client, progress, logger });
      assert.deepEqual(result.failed.map(({ name }) => name), ["Stale"]);
      assert.deepEqual(result.completed, [{ kind: "series", name: "Next" }]);
      assert.equal(client.calls.filter((call) => ["POST", "PATCH", "UPLOAD"].includes(call.method)).length - priorWrites, 2);
    });
  }
});

test("series resumes after an episode video checkpoint without reuploading it", async (t) => {
  const { path, progress, logger } = await setup(t);
  const originalSave = progress.save;
  let stopped = false;
  progress.save = async () => {
    const item = progress.state.series.Show?.seasons?.[1]?.episodes?.[1];
    if (!stopped && item?.videoUploaded && item.completed) {
      stopped = true;
      throw new Error("interrupted after video checkpoint");
    }
    return originalSave();
  };
  const client = fakeClient();
  const input = source([], [series("Show", [episode(1, 1, { video: { localPath: "/safe/episode.mp4", fileName: "episode.mp4", byteSize: 12 } })])]);
  await assert.rejects(importContent({ source: input, client, progress, logger }), /interrupted after video checkpoint/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).series.Show.seasons[1].episodes[1].videoUploaded, true);
  const reopened = await openProgressStore({ path, targetOrigin: "https://target.example.test", sourceIdentity: identity });
  const second = await importContent({ source: input, client, progress: reopened, logger });
  assert.deepEqual(second.resumed, [{ kind: "series", name: "Show" }]);
  assert.equal(client.calls.filter((call) => call.method === "UPLOAD" && call.path.includes("/episodes/")).length, 1);
});

for (const [checkpoint, version] of [["season", 3], ["episode", 4], ["duration", 5]]) {
  test(`series reopens disk after saved ${checkpoint} checkpoint without repeating writes`, async (t) => {
    const { path, progress, logger } = await setup(t);
    const originalSave = progress.save;
    progress.save = async () => {
      await originalSave();
      if (progress.state.series.Show?.version === version) throw new Error(`stopped after ${checkpoint} saved`);
    };
    const client = fakeClient();
    const video = { localPath: "/safe/episode.mp4", byteSize: 12 };
    const input = source([], [series("Show", [episode(1, 1, { video })])]);
    await assert.rejects(importContent({ source: input, client, progress, logger }), /stopped after .* saved/);
    const reopened = await openProgressStore({ path, targetOrigin: "https://target.example.test", sourceIdentity: identity });
    assert.notEqual(reopened.state, progress.state);
    const saved = reopened.state.series.Show;
    assert.equal(saved.version, version);
    assert.equal(saved.seasons[1].id, "season-2");
    if (checkpoint === "season") assert.deepEqual(saved.seasons[1].episodes, {});
    else assert.deepEqual(saved.seasons[1].episodes[1], checkpoint === "episode"
      ? { id: "episode-3", version: 1 }
      : { id: "episode-3", version: 2, metadataUpdated: true });
    const second = await importContent({ source: input, client, progress: reopened, logger });
    assert.deepEqual(second.resumed, [{ kind: "series", name: "Show" }]);
    for (const [method, route] of [["POST", "/api/admin/series"], ["POST", "/seasons"], ["POST", "/episodes"], ["PATCH", "/episodes/episode-3"]]) {
      assert.equal(client.calls.filter((call) => call.method === method && call.path.endsWith(route)).length, 1, route);
    }
    assert.equal(client.records.get(saved.id).seasons[0].episodes[0].duration_seconds, 45);
    assert.equal(JSON.parse(await readFile(path, "utf8")).series.Show.completed, true);
  });
}

test("logs import and upload stages before their work without paths or authentication data", async (t) => {
  const { progress, messages, logger } = await setup(t);
  const client = fakeClient();
  const poster = { localPath: "/private/source/poster.png", fileName: "private-poster.png", byteSize: 8 };
  const video = { localPath: "/private/source/film.mp4", fileName: "private-film.mp4", byteSize: 12 };
  const originalUpload = client.upload;
  client.upload = async (path, file) => {
    assert.match(messages.at(-1)?.[1] ?? "", /^UPLOAD /, "stage must be visible while upload is pending");
    return originalUpload(path, file);
  };
  const originalJson = client.json;
  client.json = async (method, path, body) => {
    if (method === "POST" && ["/api/admin/movies", "/api/admin/series"].includes(path)) {
      assert.match(messages.at(-1)?.[1] ?? "", /^IMPORT /, "stage must precede content creation");
    }
    return originalJson(method, path, body);
  };
  await importContent({ source: source([movie("Film", { poster, video })], [series("Show", [episode(1, 1, { video })], { poster })]), client, progress, logger });
  const stages = messages.map(([, message]) => message).filter((message) => /^(IMPORT|UPLOAD) /.test(message));
  assert.deepEqual(stages, ["IMPORT movie Film", "UPLOAD movie Film poster", "UPLOAD movie Film video",
    "IMPORT series Show", "UPLOAD series Show poster", "UPLOAD episode Show 1x1 video"]);
  assert.doesNotMatch(messages.flat().join("\n"), /\/private|private-poster|private-film|cookie|csrf|password/i);
});

test("series exact-name conflict skips only series and prototype-like name resumes safely", async (t) => {
  const { path, progress, logger } = await setup(t);
  const client = fakeClient({ existingSeries: [listItem("Existing", "series")], existingMovies: [listItem("constructor", "movie")] });
  const input = source([], [series("Existing"), series("constructor", [episode(1, 1)])]);
  const result = await importContent({ source: input, client, progress, logger });
  assert.deepEqual(result.skipped, [{ kind: "series", name: "Existing" }]);
  assert.deepEqual(result.completed, [{ kind: "series", name: "constructor" }]);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")).series, "constructor"), true);
  await importContent({ source: input, client, progress, logger });
  assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/admin/series").length, 1);
});

test("series episode business failure leaves its checkpoint and continues to next content", async (t) => {
  const { path, progress, logger } = await setup(t);
  const client = fakeClient({ failure({ method, path }) {
    if (method === "PATCH" && path.includes("/episodes/")) return new ImportRequestError("invalid duration", { status: 422 });
  } });
  const result = await importContent({ source: source([], [series("Bad", [episode(1, 1)]), series("Good")]), client, progress, logger });
  assert.deepEqual(result.failed, [{ kind: "series", name: "Bad", error: "invalid duration" }]);
  assert.equal(progress.state.series.Good.completed, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).series.Bad.seasons[1].episodes[1], { id: "episode-3", version: 1 });
});
