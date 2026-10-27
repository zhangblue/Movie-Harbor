import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { AdminApi, ViewerApi, baseURL } from "./helpers";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type Structured = Record<string, JsonValue>;

const runDir = process.env.E2E_RUN_DIR;
const configPath = process.env.E2E_MCP_CONFIG;
const rawKey = process.env.E2E_MCP_RAW_KEY;
if (!runDir || !configPath || !rawKey) throw new Error("MCP E2E requires isolated runner configuration");

const workspaceRoot = process.cwd();
const canonicalRunDir = realpathSync(runDir);
const entry = resolve(workspaceRoot, "mcp/dist/server.js");
const posterPath = resolve(runDir, "mcp-poster.png");
const compatibleVideoPath = resolve(runDir, "sample.mp4");
const incompatibleVideoPath = resolve(runDir, "mcp-incompatible.mkv");
const isolatedDirectories = {
  HOME: resolve(runDir, "mcp-home"),
  TMPDIR: resolve(runDir, "mcp-tmp"),
  CODEX_HOME: resolve(runDir, "mcp-codex-home"),
  XDG_CONFIG_HOME: resolve(runDir, "mcp-xdg-config"),
  XDG_CACHE_HOME: resolve(runDir, "mcp-xdg-cache"),
  XDG_DATA_HOME: resolve(runDir, "mcp-xdg-data"),
  XDG_STATE_HOME: resolve(runDir, "mcp-xdg-state"),
} as const;
for (const directory of Object.values(isolatedDirectories)) mkdirSync(directory, { recursive: true, mode: 0o700 });
const childEnvironment: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  ...isolatedDirectories,
  MOVIE_HARBOR_MCP_CONFIG: configPath,
};
const isolatedEnvironmentVariables = ["HOME", "TMPDIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;
const mediaFixtureRepresentations = [compatibleVideoPath, incompatibleVideoPath].flatMap(path => {
  const bytes = readFileSync(path);
  return [bytes.toString("base64"), bytes.toString("hex"), JSON.stringify(bytes), JSON.stringify([...bytes])];
});

function isInsideRunDir(path: string): boolean {
  const pathFromRun = relative(canonicalRunDir, realpathSync(path));
  return pathFromRun !== "" && !pathFromRun.startsWith("..") && !isAbsolute(pathFromRun);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let client: Client;
let transport: StdioClientTransport;
const observedResults: Array<Awaited<ReturnType<Client["callTool"]>>> = [];

function assertSafeResult(value: object, requireBoundedResult = true): void {
  const encoded = JSON.stringify(value);
  expect(encoded.includes("local_path"), "MCP result exposed local_path").toBe(false);
  expect(encoded.includes(rawKey), "MCP result exposed the raw key").toBe(false);
  for (const representation of mediaFixtureRepresentations) {
    expect(encoded.includes(representation), "MCP result exposed a complete media fixture representation").toBe(false);
  }
  if (requireBoundedResult) expect(encoded.length).toBeLessThan(32 * 1024);
}

async function call(name: string, args: Record<string, JsonValue>): Promise<Structured> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  observedResults.push(result);
  assertSafeResult(result);
  return result.structuredContent as Structured;
}

async function callError(name: string, args: Record<string, JsonValue>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  observedResults.push(result);
  assertSafeResult(result);
  return result;
}

test.beforeAll(async () => {
  expect(existsSync(entry)).toBe(true);
  expect(Object.keys(childEnvironment).sort()).toEqual([...isolatedEnvironmentVariables, "MOVIE_HARBOR_MCP_CONFIG", "PATH"].sort());
  expect(isInsideRunDir(configPath), "MCP config must be isolated inside E2E_RUN_DIR").toBe(true);
  for (const variable of isolatedEnvironmentVariables) {
    expect(isInsideRunDir(childEnvironment[variable] ?? ""), `${variable} must be isolated inside E2E_RUN_DIR`).toBe(true);
    expect(existsSync(childEnvironment[variable] ?? ""), `${variable} directory must exist before MCP startup`).toBe(true);
  }
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
  assertSafeResult(observedResults, false);
});

test("MCP creates, uploads and independently publishes private movie and series", async ({ request, playwright }) => {
  const prefix = `MCP E2E ${Date.now()}`;
  const poster = await call("validate_poster", { path: posterPath });
  expect(poster).toMatchObject({ path: posterPath, format: "png", mime_type: "image/png" });
  const inspected = await call("inspect_video", { path: compatibleVideoPath });
  expect(inspected).toMatchObject({ path: compatibleVideoPath, container: "mp4", compatibility: { accepted: true, conversion_required: false } });
  const duration = inspected.duration_seconds as number;
  const durationMinutes = Math.max(1, Math.round(duration / 60));
  const roundedSeconds = durationMinutes * 60;
  expect(duration).toBeGreaterThan(0);

  const listed = await call("list_genres", {});
  expect(Array.isArray(listed.genres)).toBe(true);
  const genre = await call("create_genre", { name: `${prefix} 题材`, confirmed: true });
  const genreId = genre.id as string;

  const stagedMoviePoster = await call("stage_poster", { path: posterPath, confirmed: true });
  const movie = await call("create_movie", {
    name: `${prefix} Movie`, year: 2026, duration_minutes: durationMinutes,
    synopsis: "MCP 验收电影。", visibility: "private", confirmed: true,
    genre_ids: [genreId], staged_poster_token: stagedMoviePoster.staged_poster_token,
  });
  expect(movie).toMatchObject({ status: "draft", next_actions: ["upload_movie_video"] });
  const movieUpload = await call("upload_movie_video", {
    movie_id: movie.id, version: movie.version, path: compatibleVideoPath, confirmed: true,
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
  const stagedSeriesPoster = await call("stage_poster", { path: posterPath, confirmed: true });
  const series = await call("create_series", {
    name: seriesName, year: 2025, genre_ids: [genreId],
    synopsis: "MCP 验收剧集。", visibility: "private", confirmed: true,
    staged_poster_token: stagedSeriesPoster.staged_poster_token,
  });
  expect(series).toMatchObject({ status: "draft", next_actions: ["create_season"] });
  const season = await call("create_season", { series_id: series.id, version: series.version, number: 1, confirmed: true });
  const episode = await call("create_episode", {
    series_id: series.id, season_id: season.season_id, version: season.series_version,
    number: 1, name: "Pilot", duration_seconds: duration, confirmed: true,
  });
  const episodeUpload = await call("upload_episode_video", {
    series_id: series.id, season_id: season.season_id, episode_id: episode.id,
    version: episode.version, path: compatibleVideoPath, confirmed: true,
  });
  const admin = await AdminApi.login(playwright);
  try {
    const draftSeries = await admin.get<any>(`/api/admin/series/${series.id}`);
    expect(draftSeries).toMatchObject({ status: "draft", is_private: true, year: 2025 });
    expect(draftSeries.poster).not.toBeNull();
    expect(draftSeries.genres).toEqual(expect.arrayContaining([expect.objectContaining({ id: genreId })]));
    const draftEpisode = draftSeries.seasons[0].episodes[0];
    expect(draftEpisode).toMatchObject({ name: "Pilot", duration_seconds: roundedSeconds, status: "draft" });

    const updatedEpisode = await call("update_episode_metadata", {
      series_id: series.id, season_id: season.season_id, episode_id: episode.id,
      version: episodeUpload.version, duration_seconds: 90,
    });
    const updatedSeries = await admin.get<any>(`/api/admin/series/${series.id}`);
    expect(updatedSeries.seasons[0].episodes[0].duration_seconds).toBe(120);

    const publishedEpisode = await call("publish_episode", {
      series_id: series.id, season_id: season.season_id, episode_id: episode.id,
      version: updatedEpisode.version, confirmed: true,
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
      name: `${prefix} Movie`, year: 2026, duration_seconds: roundedSeconds,
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
  const staged = await call("stage_poster", { path: posterPath, confirmed: true });
  const movie = await call("create_movie", {
    name: prefix, year: 2024, duration_minutes: Math.max(1, Math.round((converted.duration_seconds as number) / 60)),
    synopsis: "MCP 转换验收电影。", confirmed: true,
    genre_ids: [genreId], staged_poster_token: staged.staged_poster_token,
  });
  const uploaded = await call("upload_movie_video", { movie_id: movie.id, version: movie.version, path: outputPath, confirmed: true });
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
