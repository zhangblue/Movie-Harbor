import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AdminApi, ViewerApi, baseURL } from "./helpers";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type Structured = Record<string, JsonValue>;

const runDir = process.env.E2E_RUN_DIR;
const configPath = process.env.E2E_MCP_CONFIG;
const rawKey = process.env.E2E_MCP_RAW_KEY;
if (!runDir || !configPath || !rawKey) throw new Error("MCP E2E requires isolated runner configuration");

const workspaceRoot = process.cwd();
const entry = resolve(workspaceRoot, "mcp/dist/server.js");
const posterPath = resolve(runDir, "mcp-poster.png");
const compatibleVideoPath = resolve(runDir, "sample.mp4");
const incompatibleVideoPath = resolve(runDir, "mcp-incompatible.mkv");
const childEnvironment: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? runDir,
  TMPDIR: process.env.TMPDIR ?? runDir,
  MOVIE_HARBOR_MCP_CONFIG: configPath,
};

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let client: Client;
let transport: StdioClientTransport;
const observedResults: Array<Awaited<ReturnType<Client["callTool"]>>> = [];

async function call(name: string, args: Record<string, JsonValue>): Promise<Structured> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  observedResults.push(result);
  const encoded = JSON.stringify(result);
  expect(encoded).not.toContain("local_path");
  expect(encoded).not.toContain(rawKey);
  expect(encoded.length).toBeLessThan(32 * 1024);
  return result.structuredContent as Structured;
}

async function callError(name: string, args: Record<string, JsonValue>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  observedResults.push(result);
  expect(JSON.stringify(result)).not.toContain(rawKey);
  return result;
}

test.beforeAll(async () => {
  expect(existsSync(entry)).toBe(true);
  client = new Client({ name: "movie-harbor-e2e", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: workspaceRoot,
    env: childEnvironment,
    stderr: "pipe",
  });
  await client.connect(transport);
});

test.afterAll(async () => {
  await client?.close();
  expect(JSON.stringify(observedResults)).not.toContain(rawKey);
  expect(JSON.stringify(observedResults)).not.toContain("local_path");
});

test("MCP creates, uploads and independently publishes private movie and series", async ({ request, playwright }) => {
  const prefix = `MCP E2E ${Date.now()}`;
  const poster = await call("validate_poster", { path: posterPath });
  expect(poster).toMatchObject({ path: posterPath, format: "png", mime_type: "image/png" });
  const inspected = await call("inspect_video", { path: compatibleVideoPath });
  expect(inspected).toMatchObject({ path: compatibleVideoPath, container: "mp4", compatibility: { accepted: true, conversion_required: false } });
  const duration = inspected.duration_seconds as number;
  expect(duration).toBeGreaterThan(0);

  const listed = await call("list_genres", {});
  expect(Array.isArray(listed.genres)).toBe(true);
  const genre = await call("create_genre", { name: `${prefix} 题材` });
  const genreId = genre.id as string;

  const stagedMoviePoster = await call("stage_poster", { path: posterPath });
  const movie = await call("create_movie", {
    name: `${prefix} Movie`, year: 2026, duration_seconds: duration,
    genre_ids: [genreId], staged_poster_token: stagedMoviePoster.staged_poster_token,
  });
  expect(movie).toMatchObject({ status: "draft", next_actions: ["upload_movie_video"] });
  const movieUpload = await call("upload_movie_video", {
    movie_id: movie.id, version: movie.version, path: compatibleVideoPath,
  });
  expect(movieUpload).toMatchObject({ generated_file_deleted: false, next_actions: ["publish_movie"] });
  const movieBeforePublish = await (await request.get(`/api/catalog/movies/${movie.id}`)).status();
  expect(movieBeforePublish).toBe(404);
  const publishedMovie = await call("publish_movie", {
    movie_id: movie.id, version: movieUpload.version, confirmed: true,
  });
  expect(publishedMovie).toMatchObject({ id: movie.id, status: "published", next_actions: [] });

  const seriesName = `${prefix} Series`;
  expect(await call("validate_poster", { path: posterPath })).toMatchObject({ format: "png", mime_type: "image/png" });
  expect(await call("inspect_video", { path: compatibleVideoPath })).toMatchObject({ compatibility: { accepted: true, conversion_required: false } });
  expect(await call("search_series", { name: seriesName })).toMatchObject({ matches: [], next_actions: ["create_series"] });
  const stagedSeriesPoster = await call("stage_poster", { path: posterPath });
  const series = await call("create_series", {
    name: seriesName, year: 2025, genre_ids: [genreId],
    staged_poster_token: stagedSeriesPoster.staged_poster_token,
  });
  expect(series).toMatchObject({ status: "draft", next_actions: ["create_season"] });
  const season = await call("create_season", { series_id: series.id, version: series.version, number: 1 });
  const episode = await call("create_episode", {
    series_id: series.id, season_id: season.season_id, version: season.series_version,
    number: 1, name: "Pilot", duration_seconds: duration,
  });
  const episodeUpload = await call("upload_episode_video", {
    series_id: series.id, season_id: season.season_id, episode_id: episode.id,
    version: episode.version, path: compatibleVideoPath,
  });
  const admin = await AdminApi.login(playwright);
  try {
    const draftSeries = await admin.get<any>(`/api/admin/series/${series.id}`);
    expect(draftSeries).toMatchObject({ status: "draft", is_private: true, year: 2025 });
    const draftEpisode = draftSeries.seasons[0].episodes[0];
    expect(draftEpisode).toMatchObject({ name: "Pilot", duration_seconds: duration, status: "draft" });

    const publishedEpisode = await call("publish_episode", {
      series_id: series.id, season_id: season.season_id, episode_id: episode.id,
      version: episodeUpload.version, confirmed: true,
    });
    expect(publishedEpisode).toMatchObject({ status: "published", next_actions: ["publish_series"] });
    const parentStillDraft = await admin.get<any>(`/api/admin/series/${series.id}`);
    expect(parentStillDraft.status).toBe("draft");
    const publishedSeries = await call("publish_series", {
      series_id: series.id, version: publishedEpisode.series_version, confirmed: true,
    });
    expect(publishedSeries).toMatchObject({ status: "published", next_actions: [] });

    const movieDetail = await admin.get<any>(`/api/admin/movies/${movie.id}`);
    expect(movieDetail).toMatchObject({
      name: `${prefix} Movie`, year: 2026, duration_seconds: duration,
      status: "published", is_private: true,
    });
    expect(movieDetail.poster).not.toBeNull();
    expect(movieDetail.video).not.toBeNull();
    expect(movieDetail.genres).toEqual(expect.arrayContaining([expect.objectContaining({ id: genreId })]));

    const user = await admin.createUser(`mcp-viewer-${Date.now()}`);
    const viewer = await ViewerApi.login(playwright, user.username);
    try {
      expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);
      expect((await request.get(`/api/catalog/series/${series.id}`)).status()).toBe(404);
      expect((await viewer.request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(200);
      expect((await viewer.request.get(`/api/catalog/series/${series.id}`)).status()).toBe(200);
    } finally { await viewer.dispose(); }
  } finally { await admin.dispose(); }
});

test("MCP converts only after confirmation and deletes only the generated upload", async () => {
  const prefix = `MCP Convert ${Date.now()}`;
  const incompatible = await call("inspect_video", { path: incompatibleVideoPath });
  expect(incompatible).toMatchObject({ container: "mkv", compatibility: { accepted: false, conversion_required: true } });
  await callError("convert_video", { path: incompatibleVideoPath, confirmed: false });
  expect(existsSync(incompatibleVideoPath)).toBe(true);
  const converted = await call("convert_video", { path: incompatibleVideoPath, confirmed: true });
  const outputPath = converted.output_path as string;
  expect(existsSync(outputPath)).toBe(true);

  const genres = await call("list_genres", {});
  const genreId = (genres.genres as Array<{ id: string }>)[0]!.id;
  const staged = await call("stage_poster", { path: posterPath });
  const movie = await call("create_movie", {
    name: prefix, year: 2024, duration_seconds: converted.duration_seconds,
    genre_ids: [genreId], staged_poster_token: staged.staged_poster_token,
  });
  const uploaded = await call("upload_movie_video", { movie_id: movie.id, version: movie.version, path: outputPath });
  expect(uploaded).toMatchObject({ generated_file_deleted: true, retained_generated_path: null });
  expect(existsSync(outputPath)).toBe(false);
  expect(existsSync(incompatibleVideoPath)).toBe(true);
});

test("restricted MCP key rejects missing, wrong and forbidden administrator access", async ({ request, playwright }) => {
  expect((await request.get("/api/admin/genres")).status()).toBe(401);
  const wrong = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: "Bearer mhmcp_wrong-key" } });
  const restricted = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${rawKey}` } });
  try {
    expect((await wrong.get("/api/admin/genres")).status()).toBe(401);
    expect((await restricted.get("/api/admin/users")).status()).toBe(401);
    expect((await restricted.get("/api/admin/genres")).status()).toBe(200);
  } finally { await wrong.dispose(); await restricted.dispose(); }
});
