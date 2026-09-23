import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAndValidateExport } from "../tools/content-import/schema.mjs";
import { resolveMediaReference } from "../tools/content-import/media-path.mjs";

const posterName = "ab000000000000000000000000000001.jpg";
const videoName = "ab000000000000000000000000000002.mp4";
const movie = (name = "Movie") => ({
  name, synopsis: "Synopsis", year: 2024, genres: ["Drama"],
  poster_path: `/media/poster/ab/${posterName}`,
  video_path: `/media/video/ab/${videoName}`, duration_seconds: 90,
});
const series = (name = "Series", episodes = []) => ({
  name, synopsis: "Synopsis", year: null, genres: [],
  poster_path: null, episodes,
});
const episode = (season = 1, number = 1) => ({
  season_number: season, episode_number: number, name: "Pilot",
  video_path: null, duration_seconds: null,
});

async function exportFixture(t, contents = {}) {
  const directory = await mkdtemp(join(tmpdir(), "movie-harbor-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mediaRoot = join(directory, "media");
  await mkdir(join(mediaRoot, "poster", "ab"), { recursive: true });
  await mkdir(join(mediaRoot, "video", "ab"), { recursive: true });
  const posterPath = join(mediaRoot, "poster", "ab", posterName);
  const videoPath = join(mediaRoot, "video", "ab", videoName);
  await writeFile(posterPath, "poster");
  await writeFile(videoPath, "video");
  const jsonPath = join(directory, "export.json");
  const exported = { exported_at: "2026-09-24T00:00:00Z", movies: [], series: [], ...contents };
  const save = async () => {
    const bytes = Buffer.from(JSON.stringify(exported));
    await writeFile(jsonPath, bytes);
    return bytes;
  };
  await save();
  return { directory, mediaRoot, posterPath, videoPath, jsonPath, exported, save };
}

test("loads valid export and resolves controlled media", async (t) => {
  const fixture = await exportFixture(t, {
    movies: [movie()], series: [series("Series", [episode(2, 3)])],
  });
  const bytes = await fixture.save();
  const loaded = await loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot);
  assert.deepEqual(loaded.identity, {
    exportedAt: "2026-09-24T00:00:00Z",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(loaded.movies[0].poster.localPath, await realpath(fixture.posterPath));
  assert.equal(loaded.movies[0].video.localPath, await realpath(fixture.videoPath));
  assert.equal(loaded.movies[0].video.byteSize, 5);
  assert.equal(loaded.movies[0].name, "Movie");
  assert.equal(loaded.movies[0].durationSeconds, 90);
  assert.equal(loaded.series[0].episodes[0].seasonNumber, 2);
  assert.equal(loaded.series[0].episodes[0].episodeNumber, 3);
});

test("rejects duplicate names within each content type", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie("Same"), movie("Same")] });
  await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), /duplicate movie name: Same/);
  fixture.exported.movies = [];
  fixture.exported.series = [series("Same"), series("Same")];
  await fixture.save();
  await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), /duplicate series name: Same/);
  fixture.exported.movies = [movie("Same")];
  fixture.exported.series = [series("Same")];
  await fixture.save();
  await assert.doesNotReject(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot));
});

test("requires every contract field with its declared type", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie()] });
  for (const [change, message] of [
    [(value) => { delete value.movies[0].synopsis; }, /synopsis/],
    [(value) => { value.movies[0].year = "2024"; }, /year/],
    [(value) => { value.movies[0].genres = [4]; }, /genres/],
    [(value) => { value.movies[0].duration_seconds = 1.5; }, /duration_seconds/],
    [(value) => { value.movies[0].video_path = undefined; }, /video_path/],
    [(value) => { value.series = {}; }, /series/],
    [(value) => { value.exported_at = "yesterday"; }, /exported_at/],
    [(value) => { value.exported_at = "2026-02-31T00:00:00Z"; }, /exported_at/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

test("rejects blank names and repeated or nonpositive episode coordinates", async (t) => {
  const fixture = await exportFixture(t, { series: [series("Show", [episode()])] });
  for (const [change, message] of [
    [(value) => { value.series[0].name = "  "; }, /name/],
    [(value) => { value.series[0].episodes[0].name = ""; }, /name/],
    [(value) => { value.series[0].episodes.push(episode()); }, /duplicate episode.*1.*1/],
    [(value) => { value.series[0].episodes[0].season_number = 0; }, /season_number/],
    [(value) => { value.series[0].episodes[0].episode_number = -1; }, /episode_number/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

test("rejects out-of-range i32 fields and negative durations", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie()], series: [series("Show", [episode()])] });
  for (const [change, message] of [
    [(value) => { value.movies[0].year = 2147483648; }, /year/],
    [(value) => { value.movies[0].year = -2147483649; }, /year/],
    [(value) => { value.series[0].year = 2147483648; }, /year/],
    [(value) => { value.movies[0].duration_seconds = 2147483648; }, /duration_seconds/],
    [(value) => { value.movies[0].duration_seconds = -1; }, /duration_seconds/],
    [(value) => { value.series[0].episodes[0].duration_seconds = -1; }, /duration_seconds/],
    [(value) => { value.series[0].episodes[0].duration_seconds = 2147483648; }, /duration_seconds/],
    [(value) => { value.series[0].episodes[0].season_number = 2147483648; }, /season_number/],
    [(value) => { value.series[0].episodes[0].episode_number = 2147483648; }, /episode_number/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

test("rejects traversal, wrong purpose, empty segments and backslashes", async (t) => {
  const fixture = await exportFixture(t);
  for (const path of [
    "/media/poster/../../outside", `/media/video/ab/${videoName}`,
    `/media/poster//${posterName}`, `/media/poster/./${posterName}`,
    `/media/poster/ab\\${posterName}`, `/media/poster/ab/${posterName}\0`,
  ]) {
    await assert.rejects(resolveMediaReference(fixture.mediaRoot, path, "poster"), /invalid poster media path/);
  }
});

test("rejects media paths outside the backend controlled key format", async (t) => {
  const fixture = await exportFixture(t);
  for (const path of [
    "/media/poster/ab/poster.jpg",
    `/media/poster/ab/nested/${posterName}`,
    `/media/poster/zz/${posterName}`,
    `/media/poster/ac/${posterName}`,
    "/media/poster/ab/AB000000000000000000000000000001.jpg",
    `/media/poster/ab/${posterName.replace(".jpg", ".mp4")}`,
    `/media/video/ab/${videoName.replace(".mp4", ".jpg")}`,
  ]) {
    await assert.rejects(resolveMediaReference(fixture.mediaRoot, path, path.includes("/video/") ? "video" : "poster"), /invalid (poster|video) media path/);
  }
});

test("rejects links outside media root, missing files and directories", async (t) => {
  const fixture = await exportFixture(t);
  const outside = join(fixture.directory, "outside.jpg");
  await writeFile(outside, "outside");
  const escapeName = "ab000000000000000000000000000003.jpg";
  const missingName = "ab000000000000000000000000000004.jpg";
  const directoryName = "ab000000000000000000000000000005.jpg";
  await symlink(outside, join(fixture.mediaRoot, "poster", "ab", escapeName));
  await assert.rejects(
    resolveMediaReference(fixture.mediaRoot, `/media/poster/ab/${escapeName}`, "poster"),
    /media path escapes media root/,
  );
  await assert.rejects(
    resolveMediaReference(fixture.mediaRoot, `/media/poster/ab/${missingName}`, "poster"),
    new RegExp(`missing media file: /media/poster/ab/${missingName.replace(".", "\\.")}`),
  );
  await mkdir(join(fixture.mediaRoot, "poster", "ab", directoryName));
  await assert.rejects(
    resolveMediaReference(fixture.mediaRoot, `/media/poster/ab/${directoryName}`, "poster"),
    /media path is not a regular file/,
  );
});
