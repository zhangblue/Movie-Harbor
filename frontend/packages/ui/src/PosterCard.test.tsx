import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PosterCard } from "./PosterCard";

let availableWidth = 500;
let chipWidths: Record<string, number> = {};
let resizeCallback: ResizeObserverCallback | undefined;

function rect(width: number): DOMRect {
  return { x: 0, y: 0, width, height: 20, top: 0, right: width, bottom: 20, left: 0, toJSON: () => ({}) };
}

beforeEach(() => {
  availableWidth = 500;
  chipWidths = {};
  resizeCallback = undefined;
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const element = this;
    if (element.dataset.testid === "genre-list") return rect(availableWidth);
    if (element.dataset.genreCandidate !== undefined) {
      const chips = Array.from(element.querySelectorAll<HTMLElement>("[data-measure-chip]"));
      const width = chips.reduce((total, chip) => total + (chipWidths[chip.textContent ?? ""] ?? 30), 0)
        + Math.max(0, chips.length - 1) * 5;
      return rect(width);
    }
    return rect(0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resize() {
  expect(resizeCallback).toBeTypeOf("function");
  act(() => resizeCallback?.([], {} as ResizeObserver));
}

it("renders an accessible details link and at most three genre badges", () => {
  render(
    <PosterCard
      href="/movies/movie%2F1"
      title="潮汐尽头"
      kind="movie"
      year={2026}
      posterUrl="/media/poster.jpg"
      genres={["剧情", "悬疑", "科幻"]}
      genreCount={5}
    />,
  );
  expect(screen.getByRole("link", { name: "查看潮汐尽头详情" })).toHaveAttribute(
    "href",
    "/movies/movie%2F1",
  );
  expect(screen.getByRole("img", { name: "潮汐尽头海报" })).toHaveAttribute("loading", "lazy");
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual([
    "剧情",
    "悬疑",
    "科幻",
    "+2",
  ]);
  expect(screen.getByTestId("genre-measurements")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getAllByText("剧情").filter((node) => !node.closest('[aria-hidden="true"]'))).toHaveLength(1);
});

it("ignores empty genres and safely renders text that resembles markup", () => {
  render(
    <PosterCard
      href="/series/1"
      title={'<img src=x onerror="alert(1)">'}
      kind="series"
      year={null}
      genres={["", "   ", "超长题材名称不会被当作 HTML <script>alert(1)</script>"]}
    />,
  );
  expect(document.querySelector("script")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("genre-badge")).toHaveLength(1);
  expect(screen.getByTestId("genre-badge")).toHaveTextContent(/超长题材名称不会被当作 HTML/);
  expect(screen.getByText("剧集 · 年份未知")).toBeInTheDocument();
});

it("shows an aria-hidden blank poster when the poster is missing or fails", () => {
  const { rerender } = render(
    <PosterCard href="/movies/1" title="无海报电影" kind="movie" year={2020} genres={[]} />,
  );
  let blank = document.querySelector(".poster-blank");
  expect(blank).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByText("MH")).not.toBeInTheDocument();
  expect(screen.queryByText(/海报不可用/)).not.toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();

  rerender(
    <PosterCard
      href="/movies/1"
      title="无海报电影"
      kind="movie"
      year={2020}
      posterUrl="/media/missing.webp"
      genres={[]}
    />,
  );
  fireEvent.error(screen.getByRole("img", { name: "无海报电影海报" }));
  blank = document.querySelector(".poster-blank");
  expect(blank).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByText("MH")).not.toBeInTheDocument();
  expect(screen.queryByText(/海报不可用/)).not.toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("shows fewer names and an accurate overflow count when the measured row narrows", () => {
  availableWidth = 140;
  chipWidths = { 剧情: 30, 悬疑: 30, 科幻: 30, 犯罪: 30, "+2": 24, "+3": 24, "+4": 24, "+5": 24 };
  render(
    <PosterCard href="/movies/1" title="窄卡片" kind="movie" year={2026}
      genres={["剧情", "悬疑", "科幻", "犯罪"]} genreCount={5} />,
  );
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual([
    "剧情", "悬疑", "科幻", "+2",
  ]);

  availableWidth = 64;
  resize();
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual(["剧情", "+4"]);
});

it("uses measured long-tag width and can render no badge when even the overflow does not fit", () => {
  availableWidth = 55;
  chipWidths = { "一段非常长的题材名称": 120, 剧情: 30, 科幻: 30, "+3": 24, "+2": 24, "+1": 24 };
  render(
    <PosterCard href="/series/1" title="长题材" kind="series" year={2026}
      genres={["一段非常长的题材名称", "剧情", "科幻"]} />,
  );
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual(["+3"]);

  availableWidth = 10;
  resize();
  expect(screen.queryAllByTestId("genre-badge")).toHaveLength(0);
});

it("clamps inconsistent totals and recomputes overflow from the names actually shown", () => {
  const { rerender } = render(
    <PosterCard href="/movies/1" title="计数" kind="movie" year={2026}
      genres={["剧情", "悬疑", "科幻", "犯罪"]} genreCount={2} />,
  );
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual([
    "剧情", "悬疑", "科幻", "+1",
  ]);

  rerender(
    <PosterCard href="/movies/1" title="计数" kind="movie" year={2026}
      genres={["剧情"]} genreCount={99} />,
  );
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual(["剧情", "+98"]);
});

it("uses the deterministic three-name fallback when ResizeObserver is unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  render(
    <PosterCard href="/movies/1" title="服务端回退" kind="movie" year={2026}
      genres={["剧情", "悬疑", "科幻", "犯罪"]} genreCount={5} />,
  );
  expect(screen.getAllByTestId("genre-badge").map((badge) => badge.textContent)).toEqual([
    "剧情", "悬疑", "科幻", "+2",
  ]);
});
