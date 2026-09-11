import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { json, movie, series, serve } from "../test/fixtures";
import { getProgress, saveProgress, setRecentEpisode } from "./progressStore";

function setMediaTime(video: HTMLVideoElement, currentTime: number, duration = 600) {
  Object.defineProperty(video, "duration", { configurable: true, value: duration });
  video.currentTime = currentTime;
}

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key: string) { return this.#items.get(key) ?? null; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string) { this.#items.delete(key); }
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("opens movie playback from details, preserves back navigation, and uses the public media URL", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  serve((url) => url.pathname === "/api/catalog/movies/movie-1" ? json(movie) : json({}, 404));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);

  await user.click(await screen.findByRole("link", { name: "播放电影" }));
  expect(window.location.pathname).toBe("/movies/movie-1/play");
  expect(screen.getByRole("link", { name: "返回电影详情" })).toHaveAttribute("href", "/movies/movie-1");
  expect(screen.getByTestId("native-video")).toHaveAttribute("src", "/media/video-1");
  expect(screen.queryByText(/字幕|转码/)).not.toBeInTheDocument();
});

it("offers continue or start over and restores only after metadata is ready with a safe clamp", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  saveProgress("movie:movie-1", 580, 900);
  serve(() => json(movie));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  expect(video.currentTime).toBe(0);

  await user.click(screen.getByRole("button", { name: "继续播放" }));
  setMediaTime(video, 0, 500);
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(500);

  cleanup();
  render(<App />);
  const replacement = await screen.findByTestId<HTMLVideoElement>("native-video");
  await user.click(screen.getByRole("button", { name: "从头播放" }));
  setMediaTime(replacement, 0, 500);
  fireEvent.loadedMetadata(replacement);
  expect(replacement.currentTime).toBe(0);
  expect(getProgress("movie:movie-1")).toBeNull();
});

it("restores when metadata becomes ready before the visitor chooses continue", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  saveProgress("movie:movie-1", 120, 900);
  serve(() => json(movie));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  setMediaTime(video, 0, 500);
  Object.defineProperty(video, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_METADATA });
  fireEvent.loadedMetadata(video);

  await user.click(screen.getByRole("button", { name: "继续播放" }));
  expect(video.currentTime).toBe(120);
});

it("preserves saved progress and blocks native controls until a resume choice is made", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  saveProgress("movie:movie-1", 120, 900);
  serve(() => json(movie));
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  setMediaTime(video, 0, 500);
  fireEvent.loadedMetadata(video);

  expect(video).not.toHaveAttribute("controls");
  expect(screen.getByRole("button", { name: "继续播放" })).toHaveFocus();
  fireEvent(window, new Event("pagehide"));
  expect(getProgress("movie:movie-1")?.position).toBe(120);
});

it("throttles timeupdate writes to five seconds and flushes on pause and pagehide", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  serve(() => json(movie));
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  setMediaTime(video, 40);
  fireEvent.loadedMetadata(video);
  fireEvent.timeUpdate(video);
  expect(getProgress("movie:movie-1")).toBeNull();

  act(() => vi.advanceTimersByTime(4_500));
  fireEvent.timeUpdate(video);
  expect(getProgress("movie:movie-1")).toBeNull();
  act(() => vi.advanceTimersByTime(500));
  fireEvent.timeUpdate(video);
  expect(getProgress("movie:movie-1")?.position).toBe(40);

  setMediaTime(video, 75);
  fireEvent.pause(video);
  expect(getProgress("movie:movie-1")?.position).toBe(75);
  setMediaTime(video, 95);
  fireEvent(window, new Event("pagehide"));
  expect(getProgress("movie:movie-1")?.position).toBe(95);
});

it("clears progress near the end and on ended", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  serve(() => json(movie));
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  setMediaTime(video, 571, 600);
  fireEvent.pause(video);
  expect(getProgress("movie:movie-1")).toBeNull();
  saveProgress("movie:movie-1", 300, 600);
  fireEvent.ended(video);
  expect(getProgress("movie:movie-1")).toBeNull();
});

it("deep-links to the recent episode, keeps episode keys isolated, and navigates ordered boundaries with history", async () => {
  window.history.replaceState(null, "", "/series/series-1/play");
  setRecentEpisode("series:series-1", "ep-2");
  saveProgress("episode:ep-1", 40, 500);
  saveProgress("episode:ep-2", 80, 500);
  serve(() => json(series));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);

  expect(await screen.findByRole("heading", { name: "第 3 集 · 灯塔" })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/series/series-1/play/ep-2");
  expect(screen.getByRole("button", { name: "下一集" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "上一集" }));
  expect(window.location.pathname).toBe("/series/series-1/play/ep-1");
  expect(screen.getByRole("button", { name: "上一集" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下一集" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "继续播放" })).toBeInTheDocument();
  expect(getProgress("episode:ep-2")?.position).toBe(80);

  act(() => window.history.back());
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(await screen.findByRole("heading", { name: "第 3 集 · 灯塔" })).toBeInTheDocument();
});

it("selects episodes in season and episode order and disables the final next button", async () => {
  window.history.replaceState(null, "", "/series/series-1/play/ep-1");
  serve(() => json(series));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await screen.findByRole("heading", { name: "第 1 集 · 启程" });
  expect(screen.getAllByRole("button", { name: /第 \d 集 ·/ }).map((item) => item.textContent))
    .toEqual(["第 1 集 · 启程", "第 3 集 · 灯塔"]);
  await user.click(screen.getByRole("button", { name: "第 2 季" }));
  expect(screen.getByRole("button", { name: "第 1 集 · 归途" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "第 1 集 · 归途" }));
  expect(screen.getByRole("button", { name: "下一集" })).toBeDisabled();
  expect(window.location.pathname).toBe("/series/series-1/play/ep-3");
  await user.click(screen.getByRole("button", { name: "上一集" }));
  expect(screen.getByRole("button", { name: "第 1 季" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("button", { name: /第 \d 集 ·/ }).map((item) => item.textContent))
    .toEqual(["第 1 集 · 启程", "第 3 集 · 灯塔"]);
});

it("does not revive a previously browsed season after navigating away and back to an episode", async () => {
  window.history.replaceState(null, "", "/series/series-1/play/ep-1");
  serve(() => json(series));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await screen.findByRole("heading", { name: "第 1 集 · 启程" });
  await user.click(screen.getByRole("button", { name: "第 2 季" }));
  await user.click(screen.getByRole("button", { name: "下一集" }));
  await user.click(screen.getByRole("button", { name: "上一集" }));

  expect(screen.getByRole("button", { name: "第 1 季" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "第 1 集 · 启程" })).toHaveAttribute("aria-current", "true");
});

it("rejects a malformed encoded episode deep link instead of replacing it with a recent episode", async () => {
  window.history.replaceState(null, "", "/series/series-1/play/%");
  setRecentEpisode("series:series-1", "ep-2");
  serve(() => json(series));
  render(<App />);
  expect(screen.getByRole("heading", { name: "404 · 内容不存在" })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/series/series-1/play/%");
});

it("shows explicit readiness and playback error messages", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  serve(() => json(movie));
  render(<App />);
  const video = await screen.findByTestId<HTMLVideoElement>("native-video");
  expect(screen.getByRole("status")).toHaveTextContent("正在检查浏览器是否可以播放此视频");
  fireEvent.canPlay(video);
  expect(screen.getByRole("status")).toHaveTextContent("视频已可以播放");
  fireEvent.error(video);
  expect(screen.getByRole("alert")).toHaveTextContent("浏览器无法播放此视频格式");
});
