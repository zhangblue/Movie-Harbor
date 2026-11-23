import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  getViewerProgress,
  listCatalog,
  listCatalogFacets,
  mergeViewerProgress,
  putViewerProgress,
  removeViewerProgress,
  type CatalogQuery,
} from "./public";
import { clearCsrfToken, setCsrfToken } from "./http";

// 公开请求用例结束后恢复全局网络实现，避免模拟响应影响其他测试。
afterEach(() => { vi.unstubAllGlobals(); clearCsrfToken(); });

// 验证：目录请求转发全部公开筛选、连接题材参数并忽略无关字段。
it("forwards the complete typed catalog filters and fetches facets independently", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const body = String(input).endsWith("/facets")
      ? '{"genres":[{"id":"genre-a","name":"剧情"}],"years":[2026]}'
      : '{"page":2,"size":20,"total":0,"items":[]}';
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  });
  const query = {
    kind: "series",
    q: "星 海",
    genres: ["genre-b", "genre-a"],
    year: 2026,
    privacy: "private",
    sort: "year_desc",
    page: 2,
    size: 20,
    include_private: true,
  } as const;

  await listCatalog(query);
  const facets = await listCatalogFacets();

  expect(urls).toEqual([
    "/api/catalog?kind=series&q=%E6%98%9F+%E6%B5%B7&genres=genre-b%2Cgenre-a&year=2026&privacy=private&sort=year_desc&page=2&size=20",
    "/api/catalog/facets",
  ]);
  expect(facets).toEqual({ genres: [{ id: "genre-a", name: "剧情" }], years: [2026] });
});

// 验证：公开目录访问范围查询仅允许指定字面值。
it("keeps the public catalog privacy query as one explicit literal", () => {
  expectTypeOf<CatalogQuery["privacy"]>().toEqualTypeOf<"private" | undefined>();
  expectTypeOf<CatalogQuery["sort"]>().toEqualTypeOf<"recent" | "year_desc" | "year_asc" | "name_asc" | undefined>();
});

// 验证：普通用户进度 API 使用精确路径、方法、原始时间和现有 CSRF 请求边界。
it("sends viewer progress reads, merges, writes and removals through the protected contract", async () => {
  const requests: Array<{ url: string; method: string; body: string | null; csrf: string | null }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      csrf: headers.get("x-csrf-token"),
    });
    return new Response('{"progress":[],"cursors":[],"results":[]}', {
      headers: { "content-type": "application/json" },
    });
  });
  setCsrfToken("viewer-csrf");
  const progress = { position_seconds: 15, duration_seconds: 120, completed: false, updated_at: "2026-11-23T01:00:00Z" };
  const merge = {
    progress: [{ kind: "episode" as const, id: "episode/id", ...progress }],
    cursors: [{ series_id: "series/id", episode_id: "episode/id", updated_at: "2026-11-23T01:00:00Z" }],
    removals: [],
  };

  await getViewerProgress();
  await mergeViewerProgress(merge);
  await putViewerProgress("movie", "movie/id", progress);
  await removeViewerProgress("series", "series/id", { removed_at: "2026-11-23T02:00:00Z" });

  expect(requests).toEqual([
    { url: "/api/viewer/progress", method: "GET", body: null, csrf: null },
    { url: "/api/viewer/progress/merge", method: "POST", body: JSON.stringify(merge), csrf: "viewer-csrf" },
    { url: "/api/viewer/progress/movie/movie%2Fid", method: "PUT", body: JSON.stringify(progress), csrf: "viewer-csrf" },
    { url: "/api/viewer/progress/series/series%2Fid", method: "DELETE", body: '{"removed_at":"2026-11-23T02:00:00Z"}', csrf: "viewer-csrf" },
  ]);
});
