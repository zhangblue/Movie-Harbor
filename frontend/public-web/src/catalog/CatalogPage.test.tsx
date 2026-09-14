import "@testing-library/jest-dom/vitest";
// @ts-expect-error Vitest runs this test in Node while the application tsconfig intentionally excludes Node globals.
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { catalog, deferred, json, movie, movieCard, seriesCard, serve } from "../test/fixtures";
import { CatalogPagination } from "./CatalogPagination";

const styleElement = document.createElement("style");
const publicStyles = readFileSync("src/styles.css", "utf8");
styleElement.textContent = publicStyles.replace(/^@import[^;]+;/, "");
document.head.append(styleElement);

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
  expect(screen.queryByRole("navigation", { name: "目录分页" })).not.toBeInTheDocument();
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

it("requests a fixed public page size of 20", async () => {
  const requests: URL[] = [];
  serve((url) => {
    requests.push(url);
    return json({ items: [movieCard], total: 221, page: 1, size: 20 });
  });
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(requests[0]?.searchParams.get("size")).toBe("20");
});

it("offers a compact numeric window and navigates directly to page 6", async () => {
  window.history.replaceState(null, "", "/?page=5");
  const requests: URL[] = [];
  serve((url) => {
    requests.push(url);
    const page = Number(url.searchParams.get("page"));
    return json({ items: [page === 6 ? seriesCard : movieCard], total: 221, page, size: 20 });
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  const initialNavigation = screen.getByRole("navigation", { name: "目录分页" });
  await user.click(within(initialNavigation).getByRole("button", { name: "第 6 页" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.getByRole("heading", { name: "全部影片" })).toHaveFocus();
  expect(location.pathname + location.search).toBe("/?page=6");
  expect(requests.at(-1)?.searchParams.get("page")).toBe("6");
  expect(requests.at(-1)?.searchParams.get("size")).toBe("20");

  const navigation = screen.getByRole("navigation", { name: "目录分页" });
  for (const number of [1, 5, 6, 7, 12]) {
    expect(within(navigation).getByRole("button", { name: `第 ${number} 页` })).toBeInTheDocument();
  }
  expect(within(navigation).getByRole("button", { name: "第 6 页" })).toHaveAttribute("aria-current", "page");
  expect(within(navigation).getAllByText("…")).toHaveLength(2);
});

it("replaces an out-of-range page with the last page without flashing an empty result", async () => {
  window.history.replaceState(null, "", "/?page=99");
  const replaceState = vi.spyOn(window.history, "replaceState");
  const requestedPages: string[] = [];
  const renderedText: string[] = [];
  const observer = new MutationObserver(() => renderedText.push(document.body.textContent ?? ""));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  serve((url) => {
    const page = url.searchParams.get("page") ?? "1";
    requestedPages.push(page);
    return json({ items: page === "2" ? [seriesCard] : [], total: 21, page: Number(page), size: 20 });
  });

  render(<App />);
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
  observer.disconnect();
  expect(location.pathname + location.search).toBe("/?page=2");
  expect(replaceState).toHaveBeenCalledWith(null, "", "/?page=2");
  expect(requestedPages).toEqual(["99", "2"]);
  expect(renderedText.some((text) => text.includes("没有找到匹配内容"))).toBe(false);
});

it("replaces an out-of-range empty catalog URL with the first-page URL", async () => {
  window.history.replaceState(null, "", "/?page=99");
  const replaceState = vi.spyOn(window.history, "replaceState");
  const requestedPages: string[] = [];
  serve((url) => {
    const page = url.searchParams.get("page") ?? "1";
    requestedPages.push(page);
    return json({ items: [], total: 0, page: Number(page), size: 20 });
  });

  render(<App />);
  await waitFor(() => expect(location.pathname + location.search).toBe("/"));
  expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  expect(requestedPages).toEqual(["99", "1"]);
  expect(await screen.findByText("没有找到匹配内容")).toBeInTheDocument();
});

it("reserves the full desktop pagination height while the catalog is loading", async () => {
  const response = deferred<Response>();
  serve(() => response.promise);
  render(<App />);

  const slot = document.querySelector<HTMLElement>(".pagination-slot");
  expect(slot).toBeInTheDocument();
  expect(slot).toBeEmptyDOMElement();
  const loadingStyle = getComputedStyle(slot!);
  expect(loadingStyle.minHeight).toBe("91px");
  expect(loadingStyle.paddingTop).toBe("30px");

  await act(async () => response.resolve(json({ items: [movieCard], total: 221, page: 1, size: 20 })));
  await screen.findByRole("link", { name: "查看远方来信详情" });
  const navigation = within(slot!).getByRole("navigation", { name: "目录分页" });
  expect(getComputedStyle(navigation).marginTop).toBe("0px");
  expect(getComputedStyle(slot!).minHeight).toBe(loadingStyle.minHeight);
});

it("reserves the wrapped pagination height on narrow screens", () => {
  const mediaRule = Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .find((rule): rule is CSSMediaRule => "conditionText" in rule && rule.conditionText === "(max-width: 620px)");
  const slotRule = Array.from(mediaRule?.cssRules ?? [])
    .find((rule): rule is CSSStyleRule => "selectorText" in rule && rule.selectorText === ".pagination-slot");
  expect(slotRule?.style.minHeight).toBe("96px");
});

it("disables every catalog pagination action when navigation is unavailable", () => {
  render(<CatalogPagination page={2} size={20} total={60} disabled onPage={() => undefined} />);
  const navigation = screen.getByRole("navigation", { name: "目录分页" });
  for (const button of within(navigation).getAllByRole("button")) expect(button).toBeDisabled();
});

it("restores page 2 from browser navigation", async () => {
  serve((url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return json({ items: [page === 2 ? seriesCard : movieCard], total: 40, page, size: 20 });
  });
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });

  act(() => {
    window.history.pushState(null, "", "/?page=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.getByRole("button", { name: "第 2 页" })).toHaveAttribute("aria-current", "page");
});

it("removes page from the URL when changing kind or search", async () => {
  window.history.replaceState(null, "", "/?page=2");
  serve((url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return json({ items: [movieCard], total: 40, page, size: 20 });
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });

  await user.click(screen.getByRole("button", { name: "电影" }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBeNull());

  act(() => {
    window.history.pushState(null, "", "/?kind=movie&page=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "第 2 页" })).toHaveAttribute("aria-current", "page"));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "山海" } });
  await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBeNull());
  expect(new URLSearchParams(location.search).get("kind")).toBe("movie");
  expect(new URLSearchParams(location.search).get("q")).toBe("山海");
});

it("ignores a stale page response after browser navigation selects another page", async () => {
  const pageTwo = deferred<Response>();
  serve((url) => url.searchParams.get("page") === "2"
    ? pageTwo.promise
    : json({ items: [movieCard], total: 40, page: 1, size: 20 }));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });

  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  expect(screen.getByRole("status")).toHaveTextContent("正在加载");
  act(() => {
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("link", { name: "查看远方来信详情" });
  await act(async () => pageTwo.resolve(json({ items: [seriesCard], total: 40, page: 2, size: 20 })));
  expect(screen.queryByRole("link", { name: "查看群星之间详情" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});
