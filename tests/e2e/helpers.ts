import { expect, type APIRequestContext, type Playwright } from "@playwright/test";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080";
export const adminName = process.env.E2E_ADMIN_NAME ?? "task15-admin";
export const initialPassword = process.env.E2E_ADMIN_PASSWORD ?? "task15-initial-password";
export const changedPassword = process.env.E2E_CHANGED_PASSWORD ?? "task15-changed-password";
const generated = process.env.E2E_RUN_DIR;
if (!generated || !isAbsolute(generated)) throw new Error("E2E_RUN_DIR must be the runner's absolute isolated directory");
const statePath = resolve(generated, "state.json");
const configuredMediaHostDir = process.env.MEDIA_HOST_DIR;
if (!configuredMediaHostDir || !isAbsolute(configuredMediaHostDir)) throw new Error("MEDIA_HOST_DIR must be the runner's absolute isolated media directory");
const configuredDatabaseHostDir = process.env.DATABASE_HOST_DIR;
if (!configuredDatabaseHostDir || !isAbsolute(configuredDatabaseHostDir)) throw new Error("DATABASE_HOST_DIR must be the runner's absolute isolated database directory");
export const mediaHostDir = configuredMediaHostDir;

export function snapshotMediaFiles(directory = mediaHostDir): Set<string> {
  const files = new Set<string>();
  function visit(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && lstatSync(child).isFile()) files.add(child);
    }
  }
  visit(directory);
  return files;
}

export function uploadedSince(before: Set<string>): string[] {
  return [...snapshotMediaFiles()].filter((path) => !before.has(path));
}

export const poster = {
  name: "poster.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
};

export function video() {
  return { name: "sample.mp4", mimeType: "video/mp4", buffer: readFileSync(resolve(generated, "sample.mp4")) };
}

export type MediaSummary = { url: string; local_path: string };
export type Genre = { id: string; name: string; sort_order: number; enabled: boolean };
export type Movie = { id: string; version: number; name: string; status: string; poster: MediaSummary | null; video: MediaSummary | null };
export type Episode = { id: string; version: number; number: number; name: string; status: string; video: MediaSummary | null };
export type Series = { id: string; version: number; name: string; status: string; poster: MediaSummary | null; seasons: Array<{ id: string; number: number; episodes: Episode[] }> };

export class AdminApi {
  constructor(readonly request: APIRequestContext, readonly csrf: string) {}

  static async login(playwright: Playwright, password = initialPassword) {
    const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const login = await request.post("/api/admin/login", { data: { name: adminName, password } });
    expect(login.status()).toBe(200);
    const session = await request.get("/api/admin/session");
    expect(session.status()).toBe(200);
    const body = await session.json();
    return new AdminApi(request, body.csrf_token as string);
  }

  async dispose() { await this.request.dispose(); }
  private headers() { return { "X-CSRF-Token": this.csrf, Origin: baseURL }; }
  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  async write<T>(method: "post" | "patch" | "put" | "delete", path: string, data?: unknown): Promise<T> {
    const response = await this.request[method](path, { data, headers: this.headers() });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.status() === 204 ? undefined as T : response.json();
  }
  async upload<T>(path: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<T> {
    const response = await this.request.post(path, { multipart: { file }, headers: this.headers() });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
}

export async function createMovieDraftWithMedia(api: AdminApi, name: string, options: {
  synopsis: string; durationSeconds: number; includePoster?: boolean; year?: number | null; genreIds?: string[];
}) {
  let movie = await api.write<Movie>("post", "/api/admin/movies", { name });
  movie = await api.write<Movie>("patch", `/api/admin/movies/${movie.id}`, {
    version: movie.version, name, synopsis: options.synopsis, year: options.year === undefined ? 2026 : options.year,
    duration_seconds: options.durationSeconds, genre_ids: options.genreIds ?? [],
  });
  let version = movie.version;
  if (options.includePoster !== false) {
    const uploaded = await api.upload<{ version: number }>(`/api/admin/media/movies/${movie.id}/poster?version=${version}`, poster);
    version = uploaded.version;
  }
  await api.upload(`/api/admin/media/movies/${movie.id}/video?version=${version}`, video());
  return api.get<Movie>(`/api/admin/movies/${movie.id}`);
}

export async function createPublishableMovie(api: AdminApi, name: string) {
  const movie = await createMovieDraftWithMedia(api, name, { synopsis: `${name} searchable synopsis`, durationSeconds: 1 });
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: movie.version });
}

export async function createPublishableMovieWithoutPoster(api: AdminApi, name: string) {
  const movie = await createMovieDraftWithMedia(api, name, {
    synopsis: `${name} pagination fixture`, durationSeconds: 1, includePoster: false,
  });
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: movie.version });
}

export async function createSeriesDraftWithMedia(api: AdminApi, name: string, options: {
  synopsis: string; seasonNumber: number; episodeNumber: number; episodeName: string; durationSeconds: number;
  year?: number | null; genreIds?: string[];
}) {
  let series = await api.write<Series>("post", "/api/admin/series", { name });
  series = await api.write<Series>("patch", `/api/admin/series/${series.id}`, {
    version: series.version, synopsis: options.synopsis, year: options.year ?? null, genre_ids: options.genreIds ?? [],
  });
  const uploaded = await api.upload<{ version: number }>(`/api/admin/media/series/${series.id}/poster?version=${series.version}`, poster);
  series = await api.write<Series>("post", `/api/admin/series/${series.id}/seasons`, { version: uploaded.version, number: options.seasonNumber });
  const season = series.seasons.find((item) => item.number === options.seasonNumber)!;
  const episodesPath = `/api/admin/series/${series.id}/seasons/${season.id}/episodes`;
  series = await api.write<Series>("post", episodesPath, { version: series.version, number: options.episodeNumber, name: options.episodeName });
  const episode = series.seasons.find((item) => item.id === season.id)!.episodes[0];
  const updated = await api.write<{ episode: Episode }>("patch", `${episodesPath}/${episode.id}`, {
    version: episode.version, duration_seconds: options.durationSeconds,
  });
  await api.upload(`/api/admin/media/episodes/${episode.id}/video?version=${updated.episode.version}`, video());
  return api.get<Series>(`/api/admin/series/${series.id}`);
}

export function saveState(state: Record<string, unknown>) { writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 }); }
export function loadState<T>() { return JSON.parse(readFileSync(statePath, "utf8")) as T; }
