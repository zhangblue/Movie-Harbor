import { afterEach, expect, it, vi } from "vitest";

import { apiErrorCode, changePassword, createGenre, deleteMovie, getEpisodeDeleteImpact, getMovieDeleteImpact, getSeasonDeleteImpact, getSession, listAdminContent, uploadMedia } from "./admin";
import { ApiError, clearCsrfToken } from "./http";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

class FakeUploadXMLHttpRequest extends EventTarget {
  readonly upload = new EventTarget();
  url: string | undefined;
  status = 0;
  statusText = "";
  responseText = "";
  private responseHeaders = new Headers();

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(): void {}
  send(): void {}

  getAllResponseHeaders(): string {
    return [...this.responseHeaders].map(([name, value]) => `${name}: ${value}`).join("\r\n");
  }

  uploadProgress(loaded: number, total: number): void {
    this.upload.dispatchEvent(Object.assign(new Event("progress"), {
      lengthComputable: true,
      loaded,
      total,
    }));
  }

  respond(body: string): void {
    this.status = 200;
    this.statusText = "OK";
    this.responseText = body;
    this.responseHeaders = new Headers({ "content-type": "application/json" });
    this.dispatchEvent(new Event("load"));
  }
}

function installFakeUploadXhr(): FakeUploadXMLHttpRequest {
  let instance: FakeUploadXMLHttpRequest | undefined;
  vi.stubGlobal("XMLHttpRequest", class extends FakeUploadXMLHttpRequest {
    constructor() {
      super();
      instance = this;
    }
  });
  return new Proxy({} as FakeUploadXMLHttpRequest, {
    get(_target, property, receiver) {
      if (!instance) throw new Error("XMLHttpRequest was not created");
      const value = Reflect.get(instance, property, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

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

it("uses the authoritative delete-impact endpoint and returns synchronous deletion counts", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(urls.length === 1
      ? '{"name":"Movie","version":7,"season_count":0,"episode_count":0,"media_count":2}'
      : '{"deleted_media_count":2}',
    { headers: { "content-type": "application/json" } });
  }));

  expect(await getMovieDeleteImpact("movie/1")).toEqual({ name: "Movie", version: 7, season_count: 0, episode_count: 0, media_count: 2 });
  expect(await deleteMovie("movie/1", 7)).toEqual({ deleted_media_count: 2 });
  expect(urls).toEqual([
    "/api/admin/movies/movie%2F1/delete-impact",
    "/api/admin/movies/movie%2F1",
  ]);
});

it("loads authoritative season and episode deletion impact from scoped paths", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response('{"display_name":"Child","version":9,"season_count":0,"episode_count":1,"media_count":1}',
      { headers: { "content-type": "application/json" } });
  }));

  expect((await getSeasonDeleteImpact("series/1", "season/1")).version).toBe(9);
  expect((await getEpisodeDeleteImpact("series/1", "season/1", "episode/1")).display_name).toBe("Child");
  expect(urls).toEqual([
    "/api/admin/series/series%2F1/seasons/season%2F1/delete-impact",
    "/api/admin/series/series%2F1/seasons/season%2F1/episodes/episode%2F1/delete-impact",
  ]);
});

it("reads stable API error codes only from object details with a string code", () => {
  expect(apiErrorCode(new ApiError(500, "Error", "failed", { code: "media_delete_failed" }))).toBe("media_delete_failed");
  for (const details of [undefined, null, "media_delete_failed", 1, { code: 1 }, { code: null }]) {
    expect(apiErrorCode(new ApiError(500, "Error", "failed", details))).toBeUndefined();
  }
});

it("loads the unified admin content page with filters", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response('{"page":2,"size":20,"total":21,"items":[]}', {
      headers: { "content-type": "application/json" },
    });
  }));

  expect(await listAdminContent({ kind: "series", status: "archived", name: "长 夜", page: 2 }))
    .toMatchObject({ page: 2, size: 20, total: 21 });
  expect(urls).toEqual(["/api/admin/contents?kind=series&status=archived&name=%E9%95%BF+%E5%A4%9C&page=2"]);
});

it("does not forward unknown runtime query fields", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response('{"page":1,"size":20,"total":0,"items":[]}', {
      headers: { "content-type": "application/json" },
    });
  }));

  const query = { kind: "series", status: "archived", name: "长 夜", page: 2, size: 100, unknown: "ignored" } as const;
  await listAdminContent(query);

  expect(urls).toEqual(["/api/admin/contents?kind=series&status=archived&name=%E9%95%BF+%E5%A4%9C&page=2"]);
});

it("keeps poster uploads on fetch when no progress callback is supplied", async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response('{"id":"media-1","url":"/media/poster.jpg"}', {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);

  await uploadMedia(
    { kind: "movies", id: "movie/1", slot: "poster" },
    new File(["poster"], "one.jpg", { type: "image/jpeg" }),
    7,
  );

  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/media/movies/movie%2F1/poster?version=7");
});

it("uses the progress upload boundary for video uploads and forwards its events", async () => {
  const xhr = installFakeUploadXhr();
  const events: Array<{ phase: string; percent: number | null }> = [];

  const request = uploadMedia(
    { kind: "movies", id: "movie/1", slot: "video" },
    new File(["video"], "one.mp4", { type: "video/mp4" }),
    7,
    (progress) => events.push(progress),
  );
  xhr.uploadProgress(40, 100);
  xhr.respond('{"id":"media-1","url":"/media/video.mp4"}');

  await expect(request).resolves.toEqual({ id: "media-1", url: "/media/video.mp4" });
  expect(xhr.url).toBe("/api/admin/media/movies/movie%2F1/video?version=7");
  expect(events).toEqual([
    { phase: "uploading", percent: 0 },
    { phase: "uploading", percent: 40 },
  ]);
});
