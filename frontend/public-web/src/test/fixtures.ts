import type { CatalogCard, MovieDetail, SeriesDetail } from "@movie-harbor/api-client";
import { vi } from "vitest";

export const movieCard: CatalogCard = {
  id: "movie-1", kind: "movie", name: "远方来信", year: 2024,
  poster_url: "/media/poster-1", published_at: "2026-09-01T00:00:00Z",
  genres: [{ id: "g1", name: "剧情" }, { id: "g2", name: "冒险" }, { id: "g3", name: "悬疑" }], genre_count: 4,
};
export const seriesCard: CatalogCard = {
  id: "series-1", kind: "series", name: "群星之间", year: 2025,
  poster_url: "/media/poster-2", published_at: "2026-09-02T00:00:00Z",
  genres: [{ id: "g4", name: "科幻" }], genre_count: 1,
};
export const movie: MovieDetail = {
  id: "movie-1", kind: "movie", name: "远方来信", synopsis: "一封信，穿越山海。", year: 2024,
  duration_seconds: 5400, poster_url: "/media/poster-1", video_url: "/media/video-1",
  genres: [...movieCard.genres, { id: "g5", name: "家庭" }],
};
export const series: SeriesDetail = {
  id: "series-1", kind: "series", name: "群星之间", synopsis: "在遥远星系重逢。", year: 2025,
  poster_url: "/media/poster-2", genres: seriesCard.genres,
  seasons: [
    { id: "season-2", number: 2, episodes: [
      { id: "ep-3", number: 1, name: "归途", synopsis: "第二次旅程", duration_seconds: 1800, video_url: "/media/ep-3" },
    ] },
    { id: "season-1", number: 1, episodes: [
      { id: "ep-2", number: 3, name: "灯塔", synopsis: "照亮前路", duration_seconds: 2400, video_url: "/media/ep-2" },
      { id: "ep-1", number: 1, name: "启程", synopsis: "第一步", duration_seconds: 2100, video_url: "/media/ep-1" },
    ] },
  ],
};
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
export function catalog(items: CatalogCard[], total = items.length, page = 1) {
  return json({ items, total, page, size: 25 });
}
// Only the network boundary is replaced; shared request encoding and error handling run unchanged.
export function serve(handler: (url: URL) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", (input: string) => handler(new URL(input, "http://localhost")));
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
