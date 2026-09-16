import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AdminApi, adminName, initialPassword, createMovieDraftWithMedia, createSeriesDraftWithMedia, createPublishableMovie, type Movie, type Series } from "./helpers";

type ExportMovie = { name: string; synopsis: string; poster_path: string | null; video_path: string | null; duration_seconds: number | null };
type ExportEpisode = { season_number: number; episode_number: number; name: string; video_path: string | null; duration_seconds: number | null };
type ExportSeries = { name: string; synopsis: string; poster_path: string | null; episodes: ExportEpisode[] };
type ContentExport = { exported_at: string; movies: ExportMovie[]; series: ExportSeries[] };

test("JSON export includes every state and page with exact media paths and seconds", async ({ page, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const api = await AdminApi.login(playwright);
  const prefix = `Export ${randomUUID()}`;
  try {
    const movie = await createMovieDraftWithMedia(api, `${prefix} Movie`, {
      synopsis: "Movie export synopsis", durationSeconds: 125,
    });
    const series = await createSeriesDraftWithMedia(api, `${prefix} Series`, {
      synopsis: "Series export synopsis", seasonNumber: 4, episodeNumber: 7, episodeName: `${prefix} Episode`, durationSeconds: 367,
    });
    const season = series.seasons.find((item) => item.number === 4)!;
    const episode = season.episodes[0];
    await api.write<Series>("post", `/api/admin/series/${series.id}/seasons/${season.id}/episodes`, {
      version: series.version, number: 9, name: `${prefix} Empty Episode`,
    });

    const published = await createPublishableMovie(api, `${prefix} Published`);
    const toArchive = await createPublishableMovie(api, `${prefix} Archived`);
    const archived = await api.write<Movie>("post", `/api/admin/movies/${toArchive.id}/archive`, { version: toArchive.version });
    expect([movie.status, published.status, archived.status]).toEqual(["draft", "published", "archived"]);
    const otherSeriesNames: string[] = [];
    for (const status of ["published", "archived"] as const) {
      let other = await createSeriesDraftWithMedia(api, `${prefix} ${status} Series`, {
        synopsis: `${status} series synopsis`, seasonNumber: 2, episodeNumber: 3,
        episodeName: `${prefix} ${status} Episode`, durationSeconds: 91,
      });
      const otherSeason = other.seasons[0];
      const otherEpisode = otherSeason.episodes[0];
      const publishedEpisode = await api.write<{ series_version: number }>("post", `/api/admin/series/${other.id}/seasons/${otherSeason.id}/episodes/${otherEpisode.id}/publish`, { version: otherEpisode.version });
      other = await api.write<Series>("post", `/api/admin/series/${other.id}/publish`, { version: publishedEpisode.series_version });
      if (status === "archived") other = await api.write<Series>("post", `/api/admin/series/${other.id}/archive`, { version: other.version });
      expect(other.status).toBe(status);
      otherSeriesNames.push(other.name);
    }
    const emptyNames = Array.from({ length: 21 }, (_, index) => `${prefix} Empty ${String(index).padStart(2, "0")}`);
    for (const name of emptyNames) await api.write("post", "/api/admin/movies", { name });
    const emptySeries = await api.write<Series>("post", "/api/admin/series", { name: `${prefix} Empty Series` });

    await page.goto("/admin/");
    await page.getByLabel("管理员名称").fill(adminName);
    await page.getByLabel("密码").fill(initialPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByLabel("内容形态").selectOption("movie");
    await page.getByLabel("状态", { exact: true }).selectOption("draft");
    await page.getByLabel("名称", { exact: true }).fill(`${prefix} Empty`);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByText("共 21 条 · 第 1/2 页")).toBeVisible();
    await page.getByRole("button", { name: "第 2 页", exact: true }).click();
    await expect(page.getByText("共 21 条 · 第 2/2 页")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^movie-harbor-content-export-\d{8}-\d{6}\.json$/);
    const outputPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(outputPath);
    const exported: ContentExport = JSON.parse(await readFile(outputPath, "utf8"));
    expect(Object.keys(exported).sort()).toEqual(["exported_at", "movies", "series"]);
    expect(Number.isNaN(Date.parse(exported.exported_at))).toBe(false);
    expect(JSON.stringify(exported)).not.toMatch(/"status"\s*:/);
    expect(exported.series.map((item) => item.name)).toEqual(expect.arrayContaining(otherSeriesNames));
    const exportedMovie = exported.movies.find((item) => item.name === movie.name)!;
    expect(exportedMovie).toEqual({
      name: movie.name, synopsis: "Movie export synopsis", poster_path: movie.poster!.local_path,
      video_path: movie.video!.local_path, duration_seconds: 125,
    });
    expect(exportedMovie.poster_path).toMatch(/^\/media\/poster\//);
    expect(exportedMovie.video_path).toMatch(/^\/media\/video\//);
    expect(exported.movies.map((item) => item.name)).toEqual(expect.arrayContaining([published.name, archived.name, ...emptyNames]));
    for (const name of emptyNames) expect(exported.movies.find((item) => item.name === name)).toEqual({
      name, synopsis: "", poster_path: null, video_path: null, duration_seconds: null,
    });
    const exportedSeries = exported.series.find((item) => item.name === series.name)!;
    expect(exportedSeries).toEqual({
      name: series.name, synopsis: "Series export synopsis", poster_path: series.poster!.local_path,
      episodes: [
        { season_number: 4, episode_number: 7, name: `${prefix} Episode`, video_path: episode.video!.local_path, duration_seconds: 367 },
        { season_number: 4, episode_number: 9, name: `${prefix} Empty Episode`, video_path: null, duration_seconds: null },
      ],
    });
    expect(exportedSeries.poster_path).toMatch(/^\/media\/poster\//);
    expect(exportedSeries.episodes[0].video_path).toMatch(/^\/media\/video\//);
    expect(exported.series.find((item) => item.name === emptySeries.name)).toEqual({ name: emptySeries.name, synopsis: "", poster_path: null, episodes: [] });
    await expect(page.getByText("共 21 条 · 第 2/2 页")).toBeVisible();

    await page.getByLabel("名称", { exact: true }).fill(movie.name);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(movie.name) }).getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByText(exportedMovie.video_path!, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回列表" }).click();
    await page.getByLabel("内容形态").selectOption("series");
    await page.getByLabel("名称", { exact: true }).fill(series.name);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(series.name) }).getByRole("button", { name: "编辑", exact: true }).click();
    const seasonCard = page.getByRole("article", { name: "第 4 季", exact: true });
    await seasonCard.getByRole("button", { name: "展开第 4 季" }).click();
    await expect(seasonCard.getByText(exportedSeries.episodes[0].video_path!, { exact: true })).toBeVisible();
    const emptyEpisode = seasonCard.getByRole("form", { name: `第 9 集 · ${prefix} Empty Episode` });
    await expect(emptyEpisode.getByText("尚未上传视频")).toBeVisible();
    await expect(emptyEpisode.getByText("本地存储路径：")).toHaveCount(0);
  } finally {
    await api.dispose();
  }
});
