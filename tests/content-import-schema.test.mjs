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
// 构造有效电影导出记录，供字段和媒体校验测试修改。
const movie = (name = "Movie") => ({
  name, synopsis: "Synopsis", year: 2024, genres: ["Drama"],
  poster_path: `/media/poster/ab/${posterName}`,
  video_path: `/media/video/ab/${videoName}`, duration_seconds: 90,
});
// 构造有效剧集导出记录，供层级校验测试修改。
const series = (name = "Series", episodes = []) => ({
  name, synopsis: "Synopsis", year: null, genres: [],
  poster_path: null, episodes,
});
// 构造有效单集导出记录，供序号和媒体校验测试修改。
const episode = (season = 1, number = 1) => ({
  season_number: season, episode_number: number, name: "Pilot",
  video_path: null, duration_seconds: null,
});

// 创建导出文件和媒体目录，供来源预检测试使用。
async function exportFixture(t, contents = {}) {
  const directory = await mkdtemp(join(tmpdir(), "movie-harbor-import-"));
  // 测试结束时删除专属导出及媒体目录，确保失败路径也清理。
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
  // 将测试导出数据写入临时文件，供预检入口读取。
  const save = async () => {
    const bytes = Buffer.from(JSON.stringify(exported));
    await writeFile(jsonPath, bytes);
    return bytes;
  };
  await save();
  return { directory, mediaRoot, posterPath, videoPath, jsonPath, exported, save };
}

// 验证加载有效导出并解析受控媒体。
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
  assert.equal(loaded.movies[0].isPrivate, false);
  assert.equal(loaded.movies[0].durationSeconds, 90);
  assert.equal(loaded.series[0].isPrivate, false);
  assert.equal(loaded.series[0].episodes[0].seasonNumber, 2);
  assert.equal(loaded.series[0].episodes[0].episodeNumber, 3);
  assert.equal(Object.hasOwn(loaded.series[0].episodes[0], "isPrivate"), false);
});

// 验证加载电影和剧集的布尔隐私字段并拒绝其他类型。
test("loads movie and series privacy booleans while rejecting non-booleans", async (t) => {
  const fixture = await exportFixture(t, {
    movies: [{ ...movie(), is_private: true }],
    series: [{ ...series("Series", [episode()]), is_private: false }],
  });
  let loaded = await loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot);
  assert.equal(loaded.movies[0].isPrivate, true);
  assert.equal(loaded.series[0].isPrivate, false);

  for (const invalid of ["true", null, 1]) {
    for (const kind of ["movies", "series"]) {
      const value = structuredClone(fixture.exported);
      value[kind][0].is_private = invalid;
      await writeFile(fixture.jsonPath, JSON.stringify(value));
      await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), /is_private must be a boolean/);
    }
  }

  const value = structuredClone(fixture.exported);
  value.series[0].episodes[0].is_private = true;
  await writeFile(fixture.jsonPath, JSON.stringify(value));
  loaded = await loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot);
  assert.equal(Object.hasOwn(loaded.series[0].episodes[0], "isPrivate"), false);
});

// 验证拒绝同种内容中的重复名称。
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

// 验证要求所有契约字段存在且类型正确。
test("requires every contract field with its declared type", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie()] });
  for (const [change, message] of [
    // 删除必填字段，供缺失字段的预检错误断言。
    [(value) => { delete value.movies[0].synopsis; }, /synopsis/],
    // 将 value.movies[0].year 改为 "2024"，供该字段的非法值校验。
    [(value) => { value.movies[0].year = "2024"; }, /year/],
    // 将 value.movies[0].genres 改为 [4]，供该字段的非法值校验。
    [(value) => { value.movies[0].genres = [4]; }, /genres/],
    // 将 value.movies[0].duration_seconds 改为 1.5，供该字段的非法值校验。
    [(value) => { value.movies[0].duration_seconds = 1.5; }, /duration_seconds/],
    // 将 value.movies[0].video_path 改为 undefined，供该字段的非法值校验。
    [(value) => { value.movies[0].video_path = undefined; }, /video_path/],
    // 将 value.series 改为 {，供该字段的非法值校验。
    [(value) => { value.series = {}; }, /series/],
    // 将 value.exported_at 改为 "yesterday"，供该字段的非法值校验。
    [(value) => { value.exported_at = "yesterday"; }, /exported_at/],
    // 将 value.exported_at 改为 "2026-02-31T00:00:00Z"，供该字段的非法值校验。
    [(value) => { value.exported_at = "2026-02-31T00:00:00Z"; }, /exported_at/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

// 验证拒绝电影和剧集的空白题材，同时保留有效名称原文。
test("rejects blank movie and series genres without trimming valid exact names", async (t) => {
  const fixture = await exportFixture(t);
  for (const kind of ["movies", "series"]) {
    for (const name of ["", " \t\n", "\u3000"]) {
      const item = kind === "movies" ? movie() : series();
      item.genres = [name];
      await writeFile(fixture.jsonPath, JSON.stringify({ ...fixture.exported, [kind]: [item] }));
      await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), /genres.*nonblank/);
    }
  }
  fixture.exported.movies = [{ ...movie(), genres: [" Drama "] }];
  await fixture.save();
  assert.deepEqual((await loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot)).movies[0].genres, [" Drama "]);
});

// 验证拒绝空白名称以及重复或非正数的单集坐标。
test("rejects blank names and repeated or nonpositive episode coordinates", async (t) => {
  const fixture = await exportFixture(t, { series: [series("Show", [episode()])] });
  for (const [change, message] of [
    // 将 value.series[0].name 改为 "  "，供该字段的非法值校验。
    [(value) => { value.series[0].name = "  "; }, /name/],
    // 将 value.series[0].episodes[0].name 改为 ""，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].name = ""; }, /name/],
    // 加入重复单集，供层级坐标唯一性校验。
    [(value) => { value.series[0].episodes.push(episode()); }, /duplicate episode.*1.*1/],
    // 将 value.series[0].episodes[0].season_number 改为 0，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].season_number = 0; }, /season_number/],
    // 将 value.series[0].episodes[0].episode_number 改为 -1，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].episode_number = -1; }, /episode_number/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

// 验证拒绝超出 i32 范围的字段和负时长。
test("rejects out-of-range i32 fields and negative durations", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie()], series: [series("Show", [episode()])] });
  for (const [change, message] of [
    // 将 value.movies[0].year 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.movies[0].year = 2147483648; }, /year/],
    // 将 value.movies[0].year 改为 -2147483649，供该字段的非法值校验。
    [(value) => { value.movies[0].year = -2147483649; }, /year/],
    // 将 value.series[0].year 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.series[0].year = 2147483648; }, /year/],
    // 将 value.movies[0].duration_seconds 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.movies[0].duration_seconds = 2147483648; }, /duration_seconds/],
    // 将 value.movies[0].duration_seconds 改为 -1，供该字段的非法值校验。
    [(value) => { value.movies[0].duration_seconds = -1; }, /duration_seconds/],
    // 将 value.series[0].episodes[0].duration_seconds 改为 -1，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].duration_seconds = -1; }, /duration_seconds/],
    // 将 value.series[0].episodes[0].duration_seconds 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].duration_seconds = 2147483648; }, /duration_seconds/],
    // 将 value.series[0].episodes[0].season_number 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].season_number = 2147483648; }, /season_number/],
    // 将 value.series[0].episodes[0].episode_number 改为 2147483648，供该字段的非法值校验。
    [(value) => { value.series[0].episodes[0].episode_number = 2147483648; }, /episode_number/],
  ]) {
    const value = structuredClone(fixture.exported);
    change(value);
    await writeFile(fixture.jsonPath, JSON.stringify(value));
    await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), message);
  }
});

// 验证拒绝目录穿越、错误用途、空路径段和反斜杠。
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

// 验证拒绝不符合后端受控键格式的媒体路径。
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

// 验证拒绝指向媒体根目录外的链接、缺失文件及目录。
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

// 验证即使受控源文件存在，预检仍拒绝 OGV。
test("preflight rejects OGV even when its controlled source file exists", async (t) => {
  const fixture = await exportFixture(t, { movies: [movie()] });
  const ogvName = videoName.replace(".mp4", ".ogv");
  await writeFile(join(fixture.mediaRoot, "video", "ab", ogvName), "video");
  fixture.exported.movies[0].video_path = `/media/video/ab/${ogvName}`;
  await fixture.save();
  await assert.rejects(loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot), /invalid video media path/);
});
