import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { saveProgress } from "../player/progressStore";
import { json, movie, movieCard } from "../test/fixtures";

// 首页测试开始前安装独立进度存储并回到根路径。
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: values.get.bind(values),
    setItem: values.set.bind(values),
  });
  window.history.replaceState(null, "", "/");
});

// 首页测试结束后卸载组件并恢复浏览器边界替身。
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// 验证：首页固定读取最近 20 条，不显示分页，并把类型、搜索和全部入口导航到浏览页。
it("loads a compact recent catalog and sends discovery actions to browse", async () => {
  const catalogUrls: URL[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog") {
      catalogUrls.push(url);
      return Promise.resolve(json({ items: [movieCard], total: 41, page: 1, size: 20 }));
    }
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole("region", { name: "最近添加" })).toBeInTheDocument();
  expect(catalogUrls[0]?.searchParams.toString()).toBe("sort=recent&page=1&size=20");
  expect(screen.queryByRole("navigation", { name: "目录分页" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "电影" })).toHaveAttribute("href", "/browse?kind=movie");
  expect(screen.getByRole("link", { name: "剧集" })).toHaveAttribute("href", "/browse?kind=series");
  expect(screen.getByRole("link", { name: "浏览全部" })).toHaveAttribute("href", "/browse");

  fireEvent.change(screen.getByRole("searchbox", { name: "搜索电影或剧集" }), { target: { value: "星 海" } });
  await user.click(screen.getByRole("button", { name: "搜索" }));
  expect(location.pathname + location.search).toBe("/browse?q=%E6%98%9F+%E6%B5%B7");
});

// 验证：登录用户存在有效进度时，继续观看区位于最近添加之前。
it("places continue watching before the recent catalog", async () => {
  saveProgress("movie:movie-1", 20, 100, undefined, "viewer");
  vi.stubGlobal("fetch", (input: string) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path === "/api/viewer/session") return Promise.resolve(json({ viewer_id: "viewer", username: "Summer", csrf_token: "csrf" }));
    if (path === "/api/viewer/progress/merge") return Promise.resolve(json({ progress: [], cursors: [], results: [] }));
    if (path === "/api/catalog/movies/movie-1") return Promise.resolve(json(movie));
    if (path === "/api/catalog") return Promise.resolve(json({ items: [movieCard], total: 1, page: 1, size: 20 }));
    return Promise.resolve(json({}, 404));
  });
  render(<App />);

  const continuing = await screen.findByRole("region", { name: "继续观看" });
  const recent = screen.getByRole("region", { name: "最近添加" });
  expect(continuing.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
