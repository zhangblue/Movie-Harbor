import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { deferred, json, movie, series, serve } from "../test/fixtures";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

it("loads movie details from a deep link with all genres, duration and a public playback entry", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  serve((url) => url.pathname === "/api/catalog/movies/movie-1" ? json(movie) : json({}, 404));
  render(<App />);
  expect(await screen.findByRole("heading", { level: 1, name: "远方来信" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "远方来信海报" })).toHaveAttribute("src", "/media/poster-1");
  expect(screen.getByText(/90 分钟/)).toBeInTheDocument();
  expect(screen.getByText("家庭")).toBeInTheDocument();
  expect(screen.getByText("一封信，穿越山海。")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "播放电影" })).toHaveAttribute("href", "/movies/movie-1/play");
});

it("orders seasons and episodes, switches season, and uses only API-returned administrator episode names", async () => {
  window.history.replaceState(null, "", "/series/series-1");
  serve((url) => url.pathname === "/api/catalog/series/series-1" ? json(series) : json({}, 404));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "群星之间" });
  const seasons = screen.getAllByRole("button", { name: /第 \d 季/ });
  expect(seasons.map((button) => button.textContent)).toEqual(["第 1 季", "第 2 季"]);
  const episodeList = screen.getByRole("list", { name: "第 1 季单集" });
  expect(episodeList).toHaveClass("episode-list");
  expect(screen.getByRole("link", { name: "第 1 集 · 启程，35 分钟" })).toBeInTheDocument();
  expect(screen.getByText("40 分钟")).toBeInTheDocument();
  expect(screen.queryByText("第一步")).not.toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /第 \d 集/ }).map((link) => link.querySelector(".episode-name")?.textContent))
    .toEqual(["第 1 集 · 启程", "第 3 集 · 灯塔"]);
  const unavailable = within(episodeList).getByText("第 4 集 · 静默航线（暂无可播放视频）").closest("div");
  expect(unavailable).toHaveClass("episode-card", "is-unavailable");
  expect(within(episodeList).queryByRole("link", { name: /静默航线/ })).not.toBeInTheDocument();
  expect(within(episodeList).getByText("时长未知")).toBeInTheDocument();
  expect(screen.queryByText(/第 2 集/)).not.toBeInTheDocument();
  await user.click(seasons[1]!);
  expect(screen.getByRole("link", { name: "第 1 集 · 归途，30 分钟" })).toHaveAttribute("href", "/series/series-1/play/ep-3");
  expect(screen.queryByRole("link", { name: /启程/ })).not.toBeInTheDocument();
});

it.each(["missing", "draft", "archived"])("uses the same public 404 for %s without displaying server state", async (id) => {
  window.history.replaceState(null, "", `/movies/${id}`);
  serve(() => json({ error: `private ${id}` }, 404));
  render(<App />);
  expect(await screen.findByRole("heading", { name: "404 · 内容不存在" })).toBeInTheDocument();
  expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/");
});

it("shows the same 404 for an unknown browser path", () => {
  window.history.replaceState(null, "", "/not-a-route");
  render(<App />);
  expect(screen.getByRole("heading", { name: "404 · 内容不存在" })).toBeInTheDocument();
});

it("ignores an old movie response after navigation to series details", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  const old = deferred<Response>();
  serve((url) => url.pathname.includes("/movies/") ? old.promise : json(series));
  render(<App />);
  act(() => { window.history.pushState(null, "", "/series/series-1"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await screen.findByRole("heading", { level: 1, name: "群星之间" });
  await act(async () => old.resolve(json(movie)));
  expect(screen.queryByRole("heading", { name: "远方来信" })).not.toBeInTheDocument();
});
