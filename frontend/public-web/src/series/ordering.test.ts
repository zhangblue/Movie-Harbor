import { expect, test } from "vitest";
import { orderEpisodes, orderedPlayableEpisodes, orderSeasons } from "./ordering";

test("orders seasons and episodes without mutating API data", () => {
  const seasons = [
    { id: "s2", number: 2, episodes: [{ id: "e2", number: 2, name: "二", duration_seconds: null, video_url: "/2" }] },
    { id: "s1", number: 1, episodes: [{ id: "e1", number: 1, name: "一", duration_seconds: null, video_url: "/1" }] },
  ];

  expect(orderSeasons(seasons).map((season) => season.id)).toEqual(["s1", "s2"]);
  expect(seasons.map((season) => season.id)).toEqual(["s2", "s1"]);
  expect(orderEpisodes([{ ...seasons[0].episodes[0], number: 2 }, { ...seasons[1].episodes[0], number: 1 }]).map((episode) => episode.number)).toEqual([1, 2]);
  expect(orderedPlayableEpisodes(seasons).map((episode) => episode.id)).toEqual(["e1", "e2"]);
});

test("keeps unavailable episodes in detail ordering but excludes them from playback", () => {
  const episodes = [
    { id: "unavailable", number: 2, name: "暂无视频", duration_seconds: null, video_url: null },
    { id: "playable", number: 1, name: "可播放", duration_seconds: null, video_url: "/playable" },
  ];
  const seasons = [{ id: "s1", number: 1, episodes }];

  expect(orderEpisodes(episodes).map((episode) => episode.id)).toEqual(["playable", "unavailable"]);
  expect(orderedPlayableEpisodes(seasons).map((episode) => episode.id)).toEqual(["playable"]);
  expect(episodes.map((episode) => episode.id)).toEqual(["unavailable", "playable"]);
});
