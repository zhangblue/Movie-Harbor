import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { catalog, deferred, json, movie, movieCard, seriesCard, serve } from "../test/fixtures";

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders the mixed public catalog with accessible cards, metadata and the five-column grid", async () => {
  serve((url) => url.pathname === "/api/catalog" && url.searchParams.get("kind") === "all"
    ? catalog([movieCard, seriesCard]) : json({}, 500));
  render(<App />);
  const card = await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(card).toHaveAttribute("href", "/movies/movie-1");
  expect(within(card).getByText("电影 · 2024")).toBeInTheDocument();
  expect(within(card).getByLabelText("题材")).toHaveTextContent("剧情冒险悬疑+1");
  expect(screen.getByRole("link", { name: "查看群星之间详情" })).toHaveTextContent("剧集 · 2025");
  expect(screen.getByRole("list", { name: "影片目录" })).toHaveClass("catalog-grid", "catalog-grid--five");
  expect(screen.getByRole("searchbox", { name: "搜索电影或剧集" }).closest("label")).toHaveClass("search-box");
  expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("switches between movie and series through the API and preserves the selection in the URL", async () => {
  serve((url) => catalog(url.searchParams.get("kind") === "movie" ? [movieCard]
    : url.searchParams.get("kind") === "series" ? [seriesCard] : [movieCard, seriesCard]));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  await user.click(screen.getByRole("button", { name: "电影" }));
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.queryByRole("link", { name: "查看群星之间详情" })).not.toBeInTheDocument();
  expect(new URLSearchParams(location.search).get("kind")).toBe("movie");
  await user.click(screen.getByRole("button", { name: "剧集" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
});

it("searches the API including synopsis matches and renders an empty result", async () => {
  serve((url) => catalog(url.searchParams.get("q") === "山海" ? [movieCard]
    : url.searchParams.get("q") ? [] : [movieCard, seriesCard]));
  render(<App />);
  const search = screen.getByRole("searchbox", { name: "搜索电影或剧集" });
  fireEvent.change(search, { target: { value: "山海" } });
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(new URLSearchParams(location.search).get("q")).toBe("山海");
  fireEvent.change(search, { target: { value: "不存在" } });
  expect(await screen.findByText("没有找到匹配内容")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /查看.*详情/ })).not.toBeInTheDocument();
});

it("restores query deep links and browser navigation", async () => {
  window.history.replaceState(null, "", "/?kind=movie&q=山海");
  serve((url) => catalog(url.searchParams.get("kind") === "series" ? [seriesCard] : [movieCard]));
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.getByRole("searchbox")).toHaveValue("山海");
  act(() => { window.history.pushState(null, "", "/?kind=series"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.getByRole("button", { name: "剧集" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("searchbox")).toHaveValue("");
});

it("enters movie details using keyboard activation and returns with browser back", async () => {
  serve((url) => url.pathname === "/api/catalog/movies/movie-1" ? json(movie) : catalog([movieCard]));
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByRole("link", { name: "查看远方来信详情" });
  card.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { level: 1, name: "远方来信" })).toBeInTheDocument();
  expect(location.pathname).toBe("/movies/movie-1");
  act(() => window.history.back());
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

it("ignores a stale request after changing the content kind", async () => {
  const old = deferred<Response>();
  serve((url) => url.searchParams.get("kind") === "all" ? old.promise : catalog([seriesCard]));
  const user = userEvent.setup();
  render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载");
  await user.click(screen.getByRole("button", { name: "剧集" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  await act(async () => { old.resolve(catalog([movieCard])); });
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
});

it("shows a recoverable error without leaking backend error details", async () => {
  let failed = true;
  serve(() => failed ? json({ error: "private database path" }, 500) : catalog([movieCard]));
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
  expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
  failed = false;
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

it("makes catalog pages after the first accessible and resets page when filtering", async () => {
  serve((url) => catalog(url.searchParams.get("page") === "2" ? [seriesCard] : [movieCard], 26,
    url.searchParams.get("page") === "2" ? 2 : 1));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.getByRole("heading", { name: "全部影片" })).not.toHaveFocus();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.getByRole("heading", { name: "全部影片" })).toHaveFocus();
  expect(new URLSearchParams(location.search).get("page")).toBe("2");
  await user.click(screen.getByRole("button", { name: "电影" }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBeNull());
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});
