import { expect, it } from "vitest";
import { buildBrowseUrl, parseBrowseUrl } from "./browseUrl";

const drama = "71000000-0000-0000-0000-000000000001";
const science = "71000000-0000-0000-0000-000000000002";

// 验证：URL 解析会修剪关键词、去重排序题材并清除非法或匿名无权条件。
it("normalizes browse URL values and removes invalid anonymous filters", () => {
  const state = parseBrowseUrl(`?kind=unknown&q=%20%E6%98%9F%20&genres=${science},bad,${drama},${science}&year=0&privacy=private&sort=unknown&page=0`, false);
  expect(state).toEqual({
    kind: "all", query: "星", genres: [drama, science], year: undefined,
    privateOnly: false, sort: "recent", page: 1,
  });
  expect(buildBrowseUrl(state, {})).toBe(`/browse?q=%E6%98%9F&genres=${drama}%2C${science}`);
});

// 验证：格式正确但 facets 中已不存在的题材会从规范 URL 移除。
it("drops stale genre IDs after facets become available", () => {
  const state = parseBrowseUrl(`?genres=${drama},${science}&privacy=private&page=3`, true, new Set([science]));
  expect(state.genres).toEqual([science]);
  expect(state.privateOnly).toBe(true);
  expect(state.page).toBe(3);
});

// 验证：除翻页外的任何条件变化回到第一页，单独翻页保留其他条件。
it("resets pages for filter changes and preserves filters for pagination", () => {
  const state = parseBrowseUrl(`?kind=series&q=%E6%98%9F&sort=name_asc&page=4`, true);
  expect(buildBrowseUrl(state, { sort: "year_desc" })).toBe("/browse?kind=series&q=%E6%98%9F&sort=year_desc");
  expect(buildBrowseUrl(state, { page: 5 })).toBe("/browse?kind=series&q=%E6%98%9F&sort=name_asc&page=5");
  expect(buildBrowseUrl(state, { kind: "movie" }, "/")).toBe("/?kind=movie&q=%E6%98%9F&sort=name_asc");
});
