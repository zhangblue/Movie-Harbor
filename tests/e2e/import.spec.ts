import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AdminApi, adminName, baseURL, initialPassword, poster, type Genre, type Movie, type Series } from "./helpers";

type Metadata = { synopsis: string; year: number | null; genres: Genre[]; duration_seconds: number | null };
type ImportedSeries = Series & Metadata & { seasons: Array<{ id: string; number: number; episodes: Array<{ id: string; name: string; number: number; status: string; duration_seconds: number | null; video: { local_path: string } | null }> }> };
type Checkpoint = { movies: Record<string, { id: string }>; series: Record<string, { id: string }> };

function runImport(jsonPath: string, mediaRoot: string) {
  return new Promise<{ code: number | null; output: string }>((accept, reject) => {
    const child = spawn(process.execPath, ["tools/import-content.mjs", "--json", jsonPath, "--media-root", mediaRoot, "--target", baseURL, "--admin-name", adminName], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("import CLI timed out")); }, 45_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); accept({ code, output }); });
    child.stdin.on("error", reject);
    child.stdin.end(`${initialPassword}\n`);
  });
}

test("CLI imports media and hierarchy as drafts, resumes without duplicates, and skips conflicts", async ({ playwright }) => {
  test.setTimeout(180_000);
  const runDir = process.env.E2E_RUN_DIR!;
  const prefix = `Import ${randomUUID()}`;
  const sourceDir = resolve(runDir, `import-${randomUUID()}`);
  const mediaRoot = resolve(sourceDir, "media");
  const posterId = randomUUID().replaceAll("-", ""), videoId = randomUUID().replaceAll("-", "");
  const posterKey = `${posterId.slice(0, 2)}/${posterId}.png`;
  const videoKey = `${videoId.slice(0, 2)}/${videoId}.mp4`;
  await mkdir(resolve(mediaRoot, "poster", posterId.slice(0, 2)), { recursive: true });
  await mkdir(resolve(mediaRoot, "video", videoId.slice(0, 2)), { recursive: true });
  await writeFile(resolve(mediaRoot, "poster", posterKey), poster.buffer);
  await copyFile(resolve(runDir, "sample.mp4"), resolve(mediaRoot, "video", videoKey));
  const posterPath = `/media/poster/${posterKey}`;
  const videoPath = `/media/video/${videoKey}`;
  const movieName = `${prefix} Movie`, seriesName = `${prefix} Series`, genreName = `${prefix} Genre`;
  const jsonPath = resolve(sourceDir, "export.json");
  await writeFile(jsonPath, JSON.stringify({
    exported_at: "2026-09-24T00:00:00Z",
    movies: [{ name: movieName, synopsis: "Imported movie", year: 2024, genres: [genreName], poster_path: posterPath, video_path: videoPath, duration_seconds: 123 }],
    series: [{ name: seriesName, synopsis: "Imported series", year: 2025, genres: [genreName], poster_path: posterPath, episodes: [
      { season_number: 2, episode_number: 3, name: "Second season episode", video_path: videoPath, duration_seconds: 367 },
      { season_number: 1, episode_number: 2, name: "First season episode", video_path: videoPath, duration_seconds: 91 },
    ] }],
  }));
  const first = await runImport(jsonPath, mediaRoot);
  expect(first.code, first.output).toBe(0);
  expect(first.output).toContain("completed=2");
  expect(first.output).not.toContain(initialPassword);
  const progressPath = `${jsonPath}.movie-harbor-import-progress.json`;
  const checkpoint = JSON.parse(await readFile(progressPath, "utf8")) as Checkpoint;
  expect((await stat(progressPath)).mode & 0o777).toBe(0o600);
  const api = await AdminApi.login(playwright);
  try {
    const movie = await api.get<Movie & Metadata>(`/api/admin/movies/${checkpoint.movies[movieName].id}`);
    expect(movie).toMatchObject({ name: movieName, synopsis: "Imported movie", year: 2024, duration_seconds: 123, status: "draft" });
    expect(movie.genres.map((genre) => genre.name)).toEqual([genreName]);
    expect(movie.poster?.local_path).toMatch(/^\/media\/poster\//);
    expect(movie.video?.local_path).toMatch(/^\/media\/video\//);
    const series = await api.get<ImportedSeries>(`/api/admin/series/${checkpoint.series[seriesName].id}`);
    expect(series).toMatchObject({ name: seriesName, synopsis: "Imported series", year: 2025, status: "draft" });
    expect(series.genres.map((genre) => genre.name)).toEqual([genreName]);
    expect(series.poster?.local_path).toMatch(/^\/media\/poster\//);
    expect(series.seasons.map((season) => season.number)).toEqual([1, 2]);
    const episodes = series.seasons.flatMap((season) => season.episodes);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ name: "First season episode", number: 2, duration_seconds: 91, status: "draft" });
    expect(episodes[1]).toMatchObject({ name: "Second season episode", number: 3, duration_seconds: 367, status: "draft" });
    const paths = [movie.poster!.local_path, movie.video!.local_path, series.poster!.local_path, ...episodes.map((episode) => episode.video!.local_path)];
    expect(new Set(paths).size).toBe(5);
    for (const path of paths) expect((await stat(resolve(process.env.MEDIA_HOST_DIR!, path.slice("/media/".length)))).size).toBeGreaterThan(0);
    const second = await runImport(jsonPath, mediaRoot);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain("completed=0 resumed=0 skipped=0 failed=0");
    expect(await api.get(`/api/admin/movies/${movie.id}`)).toEqual(movie);
    expect(await api.get(`/api/admin/series/${series.id}`)).toEqual(series);
    const copyPath = resolve(sourceDir, "same-source.json");
    await copyFile(jsonPath, copyPath);
    const conflict = await runImport(copyPath, mediaRoot);
    expect(conflict.code, conflict.output).toBe(0);
    expect(conflict.output).toContain(`SKIP movie ${movieName}`);
    expect(conflict.output).toContain(`SKIP series ${seriesName}`);
    expect(conflict.output).toContain("skipped=2 failed=0");
    for (const kind of ["movie", "series"]) {
      const contents = await api.get<{ total: number }>(`/api/admin/contents?kind=${kind}&name=${encodeURIComponent(prefix)}`);
      expect(contents.total).toBe(1);
    }
    expect((await api.get<Genre[]>("/api/admin/genres")).filter((genre) => genre.name === genreName)).toHaveLength(1);
  } finally { await api.dispose(); }
});
