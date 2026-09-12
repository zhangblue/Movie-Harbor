import { afterEach, expect, it, vi } from "vitest";

import { changePassword, createGenre, deleteMovie, getEpisodeDeleteImpact, getMovieDeleteImpact, getSeasonDeleteImpact, getSession } from "./admin";
import { ApiError, clearCsrfToken } from "./http";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

it("acquires the session CSRF token in memory for later admin writes", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    new Response('{"name":"管理员","csrf_token":"from-session"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"id":"genre-1","name":"剧情","sort_order":1,"enabled":true}', {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return responses.shift()!;
  }));

  await getSession();
  await createGenre("剧情");

  expect(new Headers(requests[0]?.headers).get("x-csrf-token")).toBeNull();
  expect(new Headers(requests[1]?.headers).get("x-csrf-token")).toBe("from-session");
});

it("keeps the session CSRF token when a password change is rejected", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    new Response('{"name":"管理员","csrf_token":"still-valid"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"error":"authentication failed"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
    new Response('{"id":"genre-1","name":"剧情","sort_order":1,"enabled":true}', {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return responses.shift()!;
  }));

  await getSession();
  await expect(changePassword({ current_password: "wrong", new_password: "new-secret" })).rejects.toBeInstanceOf(ApiError);
  await createGenre("剧情");

  expect(new Headers(requests[2]?.headers).get("x-csrf-token")).toBe("still-valid");
});

it("uses the authoritative delete-impact endpoint and returns cleanup state", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(urls.length === 1
      ? '{"name":"Movie","version":7,"season_count":0,"episode_count":0,"exclusive_media_count":1,"shared_media_count":1}'
      : '{"cleanup_pending":true,"job_count":1,"warning":"media cleanup pending retry"}',
    { headers: { "content-type": "application/json" } });
  }));

  expect((await getMovieDeleteImpact("movie/1")).version).toBe(7);
  expect((await deleteMovie("movie/1", 7)).cleanup_pending).toBe(true);
  expect(urls).toEqual([
    "/api/admin/movies/movie%2F1/delete-impact",
    "/api/admin/movies/movie%2F1",
  ]);
});

it("loads authoritative season and episode deletion impact from scoped paths", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response('{"display_name":"Child","version":9,"season_count":0,"episode_count":1,"exclusive_media_count":1,"shared_media_count":0}',
      { headers: { "content-type": "application/json" } });
  }));

  expect((await getSeasonDeleteImpact("series/1", "season/1")).version).toBe(9);
  expect((await getEpisodeDeleteImpact("series/1", "season/1", "episode/1")).display_name).toBe("Child");
  expect(urls).toEqual([
    "/api/admin/series/series%2F1/seasons/season%2F1/delete-impact",
    "/api/admin/series/series%2F1/seasons/season%2F1/episodes/episode%2F1/delete-impact",
  ]);
});
