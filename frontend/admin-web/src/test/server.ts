import { vi } from "vitest";
import type { AdminContentListItem, AdminContentPage, EpisodeEnvelope, JsonValue, MovieResponse, SeriesResponse } from "@movie-harbor/api-client";

// 限定模拟接口响应载荷，在后台测试构造响应时使用。
type AdminFixturePayload = JsonValue | AdminContentPage | MovieResponse | MovieResponse[] | SeriesResponse | SeriesResponse[] | EpisodeEnvelope | undefined;

export const session = { name: "港口管理员", csrf_token: "session-csrf" };
// 构造 JSON 模拟响应，在测试服务返回接口数据时调用。
export function json(body: AdminFixturePayload, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// 构造携带文件名的导出响应，在验证下载行为时调用。
export function jsonDownload(body: JsonValue, filename = "movie-harbor-content-export-20260916-120000.json") {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
// 创建可由测试控制完成时机的 Promise，在模拟延迟响应时调用。
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
// 构造可覆盖字段的电影数据，在电影相关测试准备数据时调用。
export function movie(overrides: Partial<MovieResponse> = {}): MovieResponse {
  return {
    is_private: false,
    id: "movie-1", name: "潮汐尽头", synopsis: "海上故事", year: 2026, duration_seconds: 7200,
    status: "draft", version: 3, published_at: null, archived_at: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", genres: [],
    poster: { id: "poster-1", url: "/media/poster.webp", local_path: "/media/poster.webp", original_name: "poster.webp", mime_type: "image/webp", byte_size: 1200 },
    video: null, ...overrides,
  };
}
// 构造可覆盖字段的剧集数据，在剧集相关测试准备数据时调用。
export function series(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  const { duration_seconds: _duration, video: _video, ...base } = movie();
  return { ...base, id: "series-1", name: "长夜航线", status: "published", seasons: [], ...overrides };
}
// 构造统一内容列表行，在内容列表测试准备数据时调用。
export function adminContentItem(overrides: Partial<AdminContentListItem> = {}): AdminContentListItem {
  return {
    is_private: false,
    id: "movie-1", kind: "movie", name: "潮汐尽头", status: "draft", version: 3,
    created_at: "2026-09-01T00:00:00Z", poster_url: "/media/poster.webp", ...overrides,
  };
}
// 构造统一内容分页数据，在列表测试准备响应时调用。
export function adminContentPage(items = [
  adminContentItem(),
  adminContentItem({ id: "series-1", kind: "series", name: "长夜航线", status: "published" }),
], total = items.length, page = 1): AdminContentPage {
  return { items, total, page, size: 20 };
}
// 描述测试请求体可能的格式，在模拟服务解析请求时使用。
export type TestRequestBody = JsonValue | FormData | undefined;
// 记录模拟服务收到的请求，在测试断言请求内容时使用。
export type Request = {
  url: string;
  method: string;
  body: TestRequestBody;
  headers: Headers;
  credentials: RequestCredentials | undefined;
};
// 读取并校验模拟请求的 JSON 数据，在测试写入参数时调用。
export function requestJson<T extends object>(request: Request): T {
  if (request.body === null || typeof request.body !== "object" || request.body instanceof FormData || Array.isArray(request.body)) {
    throw new TypeError(`Expected JSON request body for ${request.method} ${request.url}`);
  }
  return request.body as T;
}
// 读取并校验模拟请求的表单数据，在测试上传参数时调用。
export function requestFormData(request: Request): FormData {
  if (!(request.body instanceof FormData)) {
    throw new TypeError(`Expected FormData request body for ${request.method} ${request.url}`);
  }
  return request.body;
}
// 安装可拦截请求的模拟服务，在后台组件测试初始化时调用。
export function server(handler?: (request: Request) => Response | Promise<Response> | undefined) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request: Request = { url, method: init.method ?? "GET", body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) as JsonValue : undefined, headers: new Headers(init.headers), credentials: init.credentials };
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
