import { vi } from "vitest";
import type { MovieResponse, SeriesResponse } from "@movie-harbor/api-client";

export const session = { name: "港口管理员", csrf_token: "session-csrf" };
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
    poster: { id: "poster-1", url: "/media/poster.webp", original_name: "poster.webp", mime_type: "image/webp", byte_size: 1200 },
    video: null, ...overrides,
  };
}
export function series(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  const { duration_seconds: _duration, video: _video, ...base } = movie();
  return { ...base, id: "series-1", name: "长夜航线", status: "published", seasons: [], ...overrides };
}
export type Request = { url: string; method: string; body: unknown; headers: Headers; credentials: RequestCredentials | undefined };
export function server(handler?: (request: Request) => Response | Promise<Response> | undefined) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined, headers: new Headers(init.headers), credentials: init.credentials };
    requests.push(request);
    const custom = handler?.(request);
    if (custom) return custom;
    if (url === "/api/admin/session") return json(session);
    if (url.startsWith("/api/admin/movies") && request.method === "GET") return json([movie()]);
    if (url.startsWith("/api/admin/series") && request.method === "GET") return json([series()]);
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  });
  return requests;
}
