import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { catalog, deferred, json, movieCard, seriesCard } from "../test/fixtures";

const drama = "71000000-0000-0000-0000-000000000001";
const science = "71000000-0000-0000-0000-000000000002";

// 浏览页测试开始前进入独立浏览路由。
beforeEach(() => window.history.replaceState(null, "", "/browse"));
// 浏览页测试结束后卸载页面并恢复网络替身。
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// 为浏览页测试构造 facets 响应。
function facets(status = 200) {
  return new Response(JSON.stringify({
    genres: [{ id: drama, name: "剧情" }, { id: science, name: "科幻" }],
    years: [2026, 2025],
  }), { status, headers: { "content-type": "application/json" } });
}

// 验证：facets 与目录独立加载和重试，facets 失败不清空已成功目录。
it("keeps catalog results when facets fail and retries facets independently", async () => {
  let facetsFail = true;
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog/facets") return Promise.resolve(facetsFail ? facets(500) : facets());
    if (url.pathname === "/api/catalog") return Promise.resolve(catalog([movieCard]));
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(screen.getByRole("alert", { name: "筛选项加载失败" })).toBeInTheDocument();
  facetsFail = false;
  await user.click(screen.getByRole("button", { name: "重试筛选项" }));
  expect(await screen.findByRole("checkbox", { name: "剧情" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

// 验证：生效条件可单独移除或全部清除，且筛选变化会移除旧页码。
it("removes active filter tags and clears all filters", async () => {
  window.history.replaceState(null, "", `/browse?genres=${drama}&year=2025&sort=name_asc&page=2`);
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog/facets") return Promise.resolve(facets());
    if (url.pathname === "/api/catalog") return Promise.resolve(catalog([movieCard], 21, Number(url.searchParams.get("page") ?? 1)));
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  render(<App />);

  await screen.findByRole("button", { name: "移除题材 剧情" });
  await user.click(screen.getByRole("button", { name: "移除年份 2025" }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("year")).toBeNull());
  expect(new URLSearchParams(location.search).get("page")).toBeNull();
  await user.click(screen.getByRole("button", { name: "清除全部" }));
  await waitFor(() => expect(location.pathname + location.search).toBe("/browse"));
});

// 验证：快速改变关键词时迟到的旧目录响应不能覆盖新 URL 的结果。
it("ignores stale catalog responses while preserving the displayed layout", async () => {
  const old = deferred<Response>();
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog/facets") return Promise.resolve(facets());
    if (url.pathname === "/api/catalog" && !url.searchParams.get("q")) return old.promise;
    if (url.pathname === "/api/catalog") return Promise.resolve(catalog([seriesCard]));
    return Promise.resolve(json({}, 404));
  });
  render(<App />);
  fireEvent.change(await screen.findByRole("searchbox", { name: "浏览关键词" }), { target: { value: "星" } });
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
  await act(async () => old.resolve(catalog([movieCard])));
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
});

// 验证：无结果状态可清除筛选，翻页完成后焦点回到结果标题。
it("offers clear action for empty results and focuses results after paging", async () => {
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog/facets") return Promise.resolve(facets());
    if (url.pathname === "/api/catalog") {
      if (url.searchParams.get("q")) return Promise.resolve(catalog([]));
      return Promise.resolve(catalog(url.searchParams.get("page") === "2" ? [seriesCard] : [movieCard], 41, Number(url.searchParams.get("page") ?? 1)));
    }
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  window.history.replaceState(null, "", "/browse?q=missing");
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "清除筛选" }));
  await screen.findByRole("link", { name: "查看远方来信详情" });
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.getByRole("heading", { name: "浏览影片" })).toHaveFocus();
});

// 验证：移动筛选抽屉打开后接收焦点，关闭后焦点返回触发按钮。
it("restores focus when the mobile filter drawer closes", async () => {
  vi.stubGlobal("fetch", (input: string) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (path === "/api/catalog/facets") return Promise.resolve(facets());
    if (path === "/api/catalog") return Promise.resolve(catalog([movieCard]));
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "筛选" });
  await user.click(trigger);
  expect(screen.getByRole("button", { name: "关闭筛选" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "关闭筛选" }));
  expect(trigger).toHaveFocus();
});
