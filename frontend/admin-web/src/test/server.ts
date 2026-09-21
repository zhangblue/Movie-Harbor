import { vi } from "vitest";
import type { AdminContentListItem, AdminContentPage, MovieResponse, SeriesResponse } from "@movie-harbor/api-client";

export const session = { name: "港口管理员", csrf_token: "session-csrf" };
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
export function jsonDownload(body: unknown, filename = "movie-harbor-content-export-20260916-120000.json") {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export function movie(overrides: Partial<MovieResponse> = {}): MovieResponse {
  return {
    id: "movie-1", name: "潮汐尽头", synopsis: "海上故事", year: 2026, duration_seconds: 7200,
    status: "draft", version: 3, published_at: null, archived_at: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", genres: [],
    poster: { id: "poster-1", url: "/media/poster.webp", local_path: "/media/poster.webp", original_name: "poster.webp", mime_type: "image/webp", byte_size: 1200 },
    video: null, ...overrides,
  };
}
export function series(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  const { duration_seconds: _duration, video: _video, ...base } = movie();
  return { ...base, id: "series-1", name: "长夜航线", status: "published", seasons: [], ...overrides };
}
export function adminContentItem(overrides: Partial<AdminContentListItem> = {}): AdminContentListItem {
  return {
    id: "movie-1", kind: "movie", name: "潮汐尽头", status: "draft", version: 3,
    created_at: "2026-09-01T00:00:00Z", poster_url: "/media/poster.webp", ...overrides,
  };
}
export function adminContentPage(items = [
  adminContentItem(),
  adminContentItem({ id: "series-1", kind: "series", name: "长夜航线", status: "published" }),
], total = items.length, page = 1): AdminContentPage {
  return { items, total, page, size: 20 };
}
export type Request = { url: string; method: string; body: any; headers: Headers; credentials: RequestCredentials | undefined };
export function server(handler?: (request: Request) => Response | Promise<Response> | undefined) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined, headers: new Headers(init.headers), credentials: init.credentials };
    requests.push(request);
    const custom = handler?.(request);
    if (custom) return custom;
    if (url === "/api/admin/session") return json(session);
    if (url.startsWith("/api/admin/contents") && request.method === "GET") return json(adminContentPage());
    if (url === "/api/admin/movies" && request.method === "GET") return json([movie()]);
    if (url === "/api/admin/series" && request.method === "GET") return json([series()]);
    if (url === "/api/admin/movies/movie-1" && request.method === "GET") return json(movie());
    if (url === "/api/admin/series/series-1" && request.method === "GET") return json(series());
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  });
  return requests;
}
