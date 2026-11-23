import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { catalog, json, movieCard } from "../test/fixtures";

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

// 验证：根路径直接展示完整浏览页，筛选后仍以根路径承载可恢复 URL 状态。
it("uses the complete browse experience as the home page", async () => {
  const catalogUrls: URL[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/viewer/session") return Promise.resolve(json({}, 401));
    if (url.pathname === "/api/catalog/facets") return Promise.resolve(json({ genres: [], years: [] }));
    if (url.pathname === "/api/catalog") {
      catalogUrls.push(url);
      return Promise.resolve(catalog([movieCard]));
    }
    return Promise.resolve(json({}, 404));
  });
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole("heading", { name: "浏览影片" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "浏览筛选" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "最近添加" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "浏览全部" })).not.toBeInTheDocument();
  expect(catalogUrls[0]?.searchParams.toString()).toBe("kind=all&sort=recent&page=1&size=20");
  await user.click(screen.getByRole("button", { name: "电影" }));
  await waitFor(() => expect(location.pathname + location.search).toBe("/?kind=movie"));
});
