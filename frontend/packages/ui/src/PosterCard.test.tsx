import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { PosterCard } from "./PosterCard";

afterEach(cleanup);

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
    "+3",
  ]);
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
  expect(screen.getByText(/超长题材名称不会被当作 HTML/)).toBeInTheDocument();
  expect(screen.getByText("剧集 · 年份未知")).toBeInTheDocument();
});

it("shows an accessible fallback when the poster is missing or fails", () => {
  const { rerender } = render(
    <PosterCard href="/movies/1" title="无海报电影" kind="movie" year={2020} genres={[]} />,
  );
  expect(screen.getByRole("img", { name: "无海报电影海报不可用" })).toBeInTheDocument();

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
  expect(screen.getByRole("img", { name: "无海报电影海报不可用" })).toBeInTheDocument();
});
