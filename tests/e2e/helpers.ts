import { expect, type APIRequestContext, type Playwright } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080";
export const adminName = process.env.E2E_ADMIN_NAME ?? "task15-admin";
export const initialPassword = process.env.E2E_ADMIN_PASSWORD ?? "task15-initial-password";
export const changedPassword = process.env.E2E_CHANGED_PASSWORD ?? "task15-changed-password";
const generated = resolve(process.cwd(), "tests/e2e/.generated");
const statePath = resolve(generated, "state.json");

export const poster = {
  name: "poster.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
};

export function video() {
  return { name: "sample.mp4", mimeType: "video/mp4", buffer: readFileSync(resolve(generated, "sample.mp4")) };
}

export type Movie = { id: string; version: number; name: string; status: string; video: null | { url: string } };
export type Series = { id: string; version: number; name: string; status: string; seasons: Array<{ id: string; number: number; episodes: Array<{ id: string; version: number; name: string; status: string; video: null | { url: string } }> }> };

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

export async function createPublishableMovie(api: AdminApi, name: string) {
  let movie = await api.write<Movie>("post", "/api/admin/movies", { name });
  movie = await api.write<Movie>("patch", `/api/admin/movies/${movie.id}`, {
    version: movie.version, name, synopsis: `${name} searchable synopsis`, year: 2026, duration_seconds: 1, genre_ids: [],
  });
  const uploadedPoster = await api.upload<{ version: number }>(`/api/admin/media/movies/${movie.id}/poster?version=${movie.version}`, poster);
  const uploadedVideo = await api.upload<{ version: number }>(`/api/admin/media/movies/${movie.id}/video?version=${uploadedPoster.version}`, video());
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: uploadedVideo.version });
}

export function saveState(state: Record<string, unknown>) { writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 }); }
export function loadState<T>() { return JSON.parse(readFileSync(statePath, "utf8")) as T; }
