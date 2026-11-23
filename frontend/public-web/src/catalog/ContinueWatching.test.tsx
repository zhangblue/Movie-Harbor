import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { completeProgress, getProgress, saveProgress } from "../player/progressStore";
import { catalog, deferred, json, movie, series } from "../test/fixtures";

// 在每个测试中安装独立的浏览器存储替身。
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: values.get.bind(values),
    setItem: values.set.bind(values),
  });
});

// 测试结束后清除页面、模拟服务和本机账号进度。
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 验证首页只为已登录账号展示仍可访问的电影及对应单集。
it.each([true, false])("shows the account's available items only when signed in (%s)", async (signedIn) => {
  window.history.replaceState(null, "", "/");
  saveProgress("movie:missing", 20, 100, undefined, "viewer");
  saveProgress("movie:movie-1", 20, 100, undefined, "viewer");
  saveProgress("episode:ep-2", 30, 200, undefined, "viewer", "series-1");
  // 按请求路径模拟独立的会话、目录与详情接口。
  vi.stubGlobal("fetch", (input: string) => {
    switch (new URL(input, "http://localhost").pathname) {
      case "/api/viewer/session": return Promise.resolve(signedIn
        ? json({ viewer_id: "viewer", username: "Summer", csrf_token: "csrf" })
        : json({}, 401));
      case "/api/catalog": return Promise.resolve(catalog([]));
      case "/api/catalog/movies/movie-1": return Promise.resolve(json(movie));
      case "/api/catalog/series/series-1": return Promise.resolve(json({ ...series, is_private: true }));
      case "/api/viewer/progress/merge": return Promise.resolve(json({ progress: [], cursors: [], results: [] }));
      default: return Promise.resolve(json({}, 404));
    }
  });
  render(<App />);
  if (!signedIn) {
    await screen.findByText("没有找到匹配内容");
    expect(screen.queryByRole("region", { name: "继续观看" })).toBeNull();
    return;
  }
  const section = await screen.findByRole("region", { name: "继续观看" });
  expect(within(section).getByRole("link", { name: /远方来信/ }).getAttribute("href")).toBe("/movies/movie-1/play?resume=1");
  expect(within(section).getByRole("link", { name: /群星之间/ }).getAttribute("href")).toBe("/series/series-1/play/ep-2?resume=1");
  expect(within(section).getByRole("link", { name: /第 1 季 · 第 3 集/ })).toBeTruthy();
  expect(within(section).getAllByRole("link")).toHaveLength(2);
  fireEvent.click(within(section).getByRole("button", { name: "移除远方来信" }));
  expect((await screen.findByRole("region", { name: "继续观看" })).textContent).not.toContain("远方来信");
  expect(getProgress("movie:movie-1", undefined, "viewer")).toBeNull();
});

// 验证：已完成单集续播卡片指向下一集，最后一集完成后不再展示整剧。
it("advances completed episodes and hides a series after its final episode", async () => {
  window.history.replaceState(null, "", "/");
  completeProgress("episode:ep-2", 200, 200, undefined, "viewer", "series-1");
  vi.stubGlobal("fetch", (input: string) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path === "/api/viewer/session") return Promise.resolve(json({ viewer_id: "viewer", username: "Summer", csrf_token: "csrf" }));
    if (path === "/api/viewer/progress/merge") return Promise.resolve(json({ progress: [], cursors: [], results: [] }));
    if (path === "/api/catalog/series/series-1") return Promise.resolve(json(series));
    return Promise.resolve(catalog([]));
  });
  const view = render(<App />);
  const section = await screen.findByRole("region", { name: "继续观看" });
  expect(within(section).getByRole("link", { name: /群星之间/ }).getAttribute("href")).toBe("/series/series-1/play/ep-3?resume=1");

  view.unmount();
  completeProgress("episode:ep-3", 200, 200, undefined, "viewer", "series-1");
  render(<App />);
  await screen.findByText("没有找到匹配内容");
  expect(screen.queryByRole("region", { name: "继续观看" })).toBeNull();
});

// 验证退出后才返回的私密详情不会让首页重新显示旧账号的记录。
it("discards delayed private details after logout", async () => {
  window.history.replaceState(null, "", "/");
  saveProgress("movie:movie-1", 20, 100, undefined, "viewer");
  const details = deferred<Response>();
  const started = deferred<void>();
  let signedIn = true;
  // 暂缓私密详情，直到退出切换完成后才释放响应。
  vi.stubGlobal("fetch", async (input: string) => {
    switch (new URL(input, "http://localhost").pathname) {
      case "/api/viewer/session":
        return signedIn ? json({ viewer_id: "viewer", username: "Summer", csrf_token: "csrf" }) : json({}, 401);
      case "/api/viewer/logout":
        signedIn = false;
        return new Response(null, { status: 204 });
      case "/api/catalog/movies/movie-1":
        started.resolve();
        return details.promise;
      default: return catalog([]);
    }
  });
  render(<App />);
  const logout = await screen.findByRole("button", { name: "退出登录" });
  await started.promise;
  fireEvent.click(logout);
  await screen.findByRole("button", { name: "登录" });
  await act(async () => details.resolve(json({ ...movie, is_private: true })));
  expect(screen.queryByRole("region", { name: "继续观看" })).toBeNull();
  expect(screen.queryByText(movie.name)).toBeNull();
});
