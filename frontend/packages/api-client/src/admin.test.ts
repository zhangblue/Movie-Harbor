import { afterEach, expect, expectTypeOf, it, vi } from "vitest";

import { apiErrorCode, changePassword, createGenre, deleteMovie, getEpisodeDeleteImpact, getMovieDeleteImpact, getSeasonDeleteImpact, getSession, listAdminContent, uploadMedia } from "./admin";
import { ApiError, apiRequest, clearCsrfToken, setCsrfToken } from "./http";
import * as client from "./index";
import type {
  AdminContentListItem, CatalogCard, CreateMovieRequest, CreateSeriesRequest,
  MovieDetail, MovieResponse, PrivacyRequest, SeriesDetail, SeriesResponse,
  ViewerSessionResponse, ViewerUserPage, ViewerUserSummary, JsonValue,
} from "./index";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

// 管理上传测试中可主动触发进度和响应的模拟请求。
class FakeUploadXMLHttpRequest extends EventTarget {
  readonly upload = new EventTarget();
  url: string | undefined;
  status = 0;
  statusText = "";
  responseText = "";
  private responseHeaders = new Headers();

  // 记录模拟请求的目标，供测试断言请求路径。
  open(_method: string, url: string): void {
    this.url = url;
  }

  // 模拟设置请求头，供上传测试使用。
  setRequestHeader(): void {}
  // 模拟发送请求，等待测试触发响应。
  send(): void {}

  // 返回模拟响应头，供上传响应解析使用。
  getAllResponseHeaders(): string {
    return [...this.responseHeaders].map(([name, value]) => `${name}: ${value}`).join("\r\n");
  }

  // 触发模拟上传进度，供测试断言进度反馈。
  uploadProgress(loaded: number, total: number): void {
    this.upload.dispatchEvent(Object.assign(new Event("progress"), {
      lengthComputable: true,
      loaded,
      total,
    }));
  }

  // 设置并触发模拟响应，供异步请求测试继续执行。
  respond(body: string): void {
    this.status = 200;
    this.statusText = "OK";
    this.responseText = body;
    this.responseHeaders = new Headers({ "content-type": "application/json" });
    this.dispatchEvent(new Event("load"));
  }
}

// 测试管理上传时安装可控制的模拟网络请求。
function installFakeUploadXhr(): FakeUploadXMLHttpRequest {
  let instance: FakeUploadXMLHttpRequest | undefined;
  vi.stubGlobal("XMLHttpRequest", class extends FakeUploadXMLHttpRequest {
    // 在测试创建模拟请求时记录当前实例，供后续触发响应。
    constructor() {
      super();
      instance = this;
    }
  });
  return new Proxy({} as FakeUploadXMLHttpRequest, {
    // 代理访问模拟请求属性，供测试操作当前实例。
    get(_target, property, receiver) {
      if (!instance) throw new Error("XMLHttpRequest was not created");
      const value = Reflect.get(instance, property, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

// 验证：恢复管理员会话后保存 CSRF 令牌，供后续写请求使用。
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

// 验证：密码修改被拒绝时保留管理员会话令牌。
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

// 验证：删除前读取权威影响并验证成功响应的同步删除数量。
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

// 验证：按所属路径读取季和单集的删除影响。
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

// 验证：仅从对象详情中的字符串字段读取稳定错误码。
it("reads stable API error codes only from object details with a string code", () => {
  expect(apiErrorCode(new ApiError(500, "Error", "failed", { code: "media_delete_failed" }))).toBe("media_delete_failed");
  for (const details of [undefined, null, "media_delete_failed", 1, { code: 1 }, { code: null }]) {
    expect(apiErrorCode(new ApiError(500, "Error", "failed", details))).toBeUndefined();
  }
});

// 验证：按筛选条件加载统一管理内容分页。
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

// 验证：忽略运行时传入的未知查询字段。
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

// 验证：未提供进度回调时使用普通请求上传海报。
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

// 验证：上传视频时转发进度上传边界的事件。
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

const viewer = {
  id: "viewer-1", username: "Summer", version: 3,
  created_at: "2026-10-10T00:00:00Z", last_login_at: null, has_active_session: false,
};
const movie = {
  id: "movie-1", name: "Movie", synopsis: "", year: null, duration_seconds: null,
  is_private: true, status: "draft", version: 4, published_at: null, archived_at: null,
  created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z",
  genres: [], poster: null, video: null,
};
const series = {
  id: "series-1", name: "Series", synopsis: "", year: null, is_private: false,
  status: "published", version: 5, published_at: "2026-10-10T00:00:00Z", archived_at: null,
  created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z",
  genres: [], poster: null, seasons: [],
};

// 测试管理请求时记录请求并依次返回预设响应。
function recordRequests(responses: Response[]) {
  const requests: Array<{ url: string; method: string | undefined; json: JsonValue | undefined; csrf: string | null; credentials: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url), method: init?.method,
      json: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      csrf: new Headers(init?.headers).get("x-csrf-token"), credentials: init?.credentials,
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  return requests;
}

// 测试 API 时构造 JSON 响应。
function jsonResponse(value: JsonValue | ViewerUserPage | ViewerUserSummary, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

// 验证：普通用户通过独立登录接口登录并在写请求前取得令牌。
it("logs viewers in through their own route and acquires CSRF before the next write", async () => {
  setCsrfToken("stale-admin-csrf");
  const requests = recordRequests([
    jsonResponse({ username: "Summer" }),
    jsonResponse({ username: "Summer", csrf_token: "viewer-csrf" }),
    new Response(null, { status: 204 }),
  ]);

  await expect(client.viewerLogin({ username: "Summer", password: "viewer-password" }))
    .resolves.toEqual({ username: "Summer" });
  await client.viewerLogout();

  expect(requests).toEqual([
    { url: "/api/viewer/login", method: "POST", json: { username: "Summer", password: "viewer-password" }, csrf: null, credentials: "same-origin" },
    { url: "/api/viewer/session", method: "GET", json: undefined, csrf: null, credentials: "same-origin" },
    { url: "/api/viewer/logout", method: "POST", json: undefined, csrf: "viewer-csrf", credentials: "same-origin" },
  ]);
});

// 验证：恢复普通用户会话并在本人改密成功后清除令牌。
it("restores viewer session and clears CSRF after successful self password change", async () => {
  const requests = recordRequests([
    jsonResponse({ username: "Summer", csrf_token: "viewer-csrf" }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
  ]);
  await expect(client.getViewerSession()).resolves.toEqual({ username: "Summer", csrf_token: "viewer-csrf" });
  await client.changeViewerPassword({ current_password: "old-password", new_password: "new-password" });
  await apiRequest("/api/viewer/logout", { method: "POST" });

  expect(requests[1]).toMatchObject({ url: "/api/viewer/password", method: "PATCH", json: { current_password: "old-password", new_password: "new-password" }, csrf: "viewer-csrf" });
  expect(requests[2]?.csrf).toBeNull();
});

// 验证：身份持有者拒绝旧会话结果时不覆盖当前令牌。
it("does not overwrite current CSRF when a viewer session is rejected by its identity owner", async () => {
  setCsrfToken("winter-csrf");
  const requests = recordRequests([
    jsonResponse({ username: "Summer", csrf_token: "summer-csrf" }),
    new Response(null, { status: 204 }),
  ]);
  await client.getViewerSession(() => false);
  await apiRequest("/api/viewer/password", { method: "PATCH" });
  expect(requests[1]?.csrf).toBe("winter-csrf");
});

// 验证：本人改密被拒绝时保留普通用户令牌。
it("preserves viewer CSRF when a self password change is rejected", async () => {
  const requests = recordRequests([
    jsonResponse({ username: "Summer", csrf_token: "still-valid" }),
    jsonResponse({ error: "当前密码不正确" }, 400),
    new Response(null, { status: 204 }),
  ]);
  await client.getViewerSession();
  await expect(client.changeViewerPassword({ current_password: "wrong", new_password: "new-password" }))
    .rejects.toBeInstanceOf(ApiError);
  await client.viewerLogout();
  expect(requests[2]?.csrf).toBe("still-valid");
});

// 验证：身份持有者拒绝过时操作结果时保留当前令牌。
it.each(["logout", "password"])("keeps current CSRF when the identity owner rejects an old %s completion", async (operation) => {
  setCsrfToken("winter-csrf");
  const requests = recordRequests([new Response(null, { status: 204 }), new Response(null, { status: 204 })]);
  if (operation === "logout") await client.viewerLogout(() => false);
  else await client.changeViewerPassword({ current_password: "old-password", new_password: "new-password" }, () => false);
  await apiRequest("/api/viewer/password", { method: "PATCH" });
  expect(requests[1]?.csrf).toBe("winter-csrf");
});

// 验证：退出接口返回不同结果后清除普通用户令牌。
it.each([204, 500])("clears viewer CSRF after logout responds with %s", async (status) => {
  setCsrfToken("viewer-csrf");
  const requests = recordRequests([
    status === 204 ? new Response(null, { status }) : jsonResponse({ error: "unavailable" }, status),
    new Response(null, { status: 204 }),
  ]);
  const result = client.viewerLogout();
  if (status === 204) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toBeInstanceOf(ApiError);
  await apiRequest("/api/viewer/logout", { method: "POST" });
  expect(requests.map((request) => request.csrf)).toEqual(["viewer-csrf", null]);
});

// 验证：普通用户登录失败前清除旧令牌且不读取会话。
it("clears old CSRF before a rejected viewer login and does not read a session", async () => {
  setCsrfToken("stale-csrf");
  const requests = recordRequests([
    jsonResponse({ error: "用户名或密码错误" }, 401), new Response(null, { status: 204 }),
  ]);
  await expect(client.viewerLogin({ username: "Summer", password: "wrong" })).rejects.toBeInstanceOf(ApiError);
  await apiRequest("/api/viewer/logout", { method: "POST" });
  expect(requests.map((request) => [request.url, request.csrf])).toEqual([
    ["/api/viewer/login", null], ["/api/viewer/logout", null],
  ]);
});

// 验证：限定普通用户列表查询字段并保留概览响应。
it("lists viewer users with a bounded query and preserves the overview response", async () => {
  const page = { page: 2, size: 20, total: 21, items: [viewer], summary: { total_users: 21, active_users: 2, latest_user: viewer } };
  const requests = recordRequests([jsonResponse(page)]);
  const query = { q: "Sum mer", page: 2, size: 20, role: "admin", unknown: "ignored" } as const;
  await expect(client.listViewerUsers(query)).resolves.toEqual(page);
  expect(requests[0]).toMatchObject({ url: "/api/admin/users?q=Sum+mer&page=2&size=20", method: "GET", csrf: null });
});

// 验证：创建、重置密码和删除用户时使用管理员路径及版本。
it("uses administrator routes for viewer creation, password reset and deletion with versions", async () => {
  setCsrfToken("admin-csrf");
  const requests = recordRequests([jsonResponse(viewer, 201), jsonResponse({ ...viewer, version: 4 }), new Response(null, { status: 204 })]);
  await expect(client.createViewerUser({ username: "Summer", password: "initial-password" })).resolves.toEqual(viewer);
  await expect(client.changeViewerUserPassword("viewer/1", { version: 3, new_password: "reset-password" })).resolves.toMatchObject({ version: 4 });
  await expect(client.deleteViewerUser("viewer/1", 4)).resolves.toBeUndefined();
  expect(requests.map(({ url, method, json, csrf }) => ({ url, method, json, csrf }))).toEqual([
    { url: "/api/admin/users", method: "POST", json: { username: "Summer", password: "initial-password" }, csrf: "admin-csrf" },
    { url: "/api/admin/users/viewer%2F1/password", method: "PUT", json: { version: 3, new_password: "reset-password" }, csrf: "admin-csrf" },
    { url: "/api/admin/users/viewer%2F1", method: "DELETE", json: { version: 4 }, csrf: "admin-csrf" },
  ]);
});

// 验证：管理内容查询转发指定访问范围筛选。
it.each(["public", "private"] as const)("forwards the %s admin content privacy filter", async (privacy) => {
  const requests = recordRequests([jsonResponse({ page: 1, size: 20, total: 0, items: [] })]);
  await client.listAdminContent({ privacy, page: 1 });
  expect(requests[0]?.url).toBe(`/api/admin/contents?privacy=${privacy}&page=1`);
});

// 验证：使用带版本的专用接口切换电影和剧集访问范围。
it("switches movie and series privacy through dedicated versioned PUT endpoints", async () => {
  const requests = recordRequests([jsonResponse(movie), jsonResponse(series)]);
  await expect(client.setMoviePrivacy("movie/1", 3, true)).resolves.toEqual(movie);
  await expect(client.setSeriesPrivacy("series/1", 4, false)).resolves.toEqual(series);
  expect(requests.map(({ url, method, json }) => ({ url, method, json }))).toEqual([
    { url: "/api/admin/movies/movie%2F1/privacy", method: "PUT", json: { version: 3, is_private: true } },
    { url: "/api/admin/series/series%2F1/privacy", method: "PUT", json: { version: 4, is_private: false } },
  ]);
});

// 验证：创建电影和剧集时显式传递公开或私密范围。
it.each([false, true])("creates movie and series with explicit is_private=%s", async (isPrivate) => {
  const requests = recordRequests([jsonResponse({ ...movie, is_private: isPrivate }, 201), jsonResponse({ ...series, is_private: isPrivate }, 201)]);
  await client.createMovie("Movie", isPrivate);
  await client.createSeries("Series", isPrivate);
  expect(requests.map(({ url, method, json }) => ({ url, method, json }))).toEqual([
    { url: "/api/admin/movies", method: "POST", json: { name: "Movie", is_private: isPrivate } },
    { url: "/api/admin/series", method: "POST", json: { name: "Series", is_private: isPrivate } },
  ]);
});

// 验证：共享包导出普通用户及访问范围所需的数据契约。
it("exports required viewer and privacy DTO contracts from the package", () => {
  expectTypeOf<ViewerSessionResponse>().toEqualTypeOf<{ username: string; csrf_token: string }>();
  expectTypeOf<ViewerUserSummary>().toEqualTypeOf<{
    id: string; username: string; version: number; created_at: string;
    last_login_at: string | null; has_active_session: boolean;
  }>();
  expectTypeOf<ViewerUserPage["summary"]>().toEqualTypeOf<{ total_users: number; active_users: number; latest_user: ViewerUserSummary | null }>();
  expectTypeOf<PrivacyRequest>().toEqualTypeOf<{ version: number; is_private: boolean }>();
  expectTypeOf<CreateMovieRequest>().toEqualTypeOf<{ name: string; is_private: boolean }>();
  expectTypeOf<CreateSeriesRequest>().toEqualTypeOf<{ name: string; is_private: boolean }>();
  expectTypeOf<Pick<AdminContentListItem | CatalogCard | MovieDetail | MovieResponse | SeriesDetail | SeriesResponse, "is_private">>()
    .toEqualTypeOf<{ is_private: boolean }>();
  if (false) {
    // @ts-expect-error Creation requires an explicit access scope.
    void client.createMovie("Movie");
    // @ts-expect-error Creation requires an explicit access scope.
    void client.createSeries("Series");
  }
});
