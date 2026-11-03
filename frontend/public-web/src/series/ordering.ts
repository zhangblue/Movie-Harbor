import type { PublicEpisode, PublicSeason } from "@movie-harbor/api-client";

// 可播放单集附带所属季的标识和序号，供选集及前后集导航使用。
export interface OrderedEpisode extends PublicEpisode {
  seasonId: string;
  seasonNumber: number;
}

// 在展示或选择剧集时按季序号排序，保留原数组。
export function orderSeasons(seasons: PublicSeason[]): PublicSeason[] {
  return [...seasons].sort((left, right) => left.number - right.number);
}

// 在展示或选择单集时按集序号排序，保留原数组。
export function orderEpisodes(episodes: PublicEpisode[]): PublicEpisode[] {
  return [...episodes].sort((left, right) => left.number - right.number);
}

// 在剧集播放时按季和集排序可播放单集，供前后集导航使用。
export function orderedPlayableEpisodes(seasons: PublicSeason[]): OrderedEpisode[] {
  return orderSeasons(seasons).flatMap((season) =>
    orderEpisodes(season.episodes)
      .filter((episode) => episode.video_url)
      .map((episode) => ({ ...episode, seasonId: season.id, seasonNumber: season.number })),
  );
}
