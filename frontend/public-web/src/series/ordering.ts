import type { PublicEpisode, PublicSeason } from "@movie-harbor/api-client";

export interface OrderedEpisode extends PublicEpisode {
  seasonId: string;
  seasonNumber: number;
}

export function orderSeasons(seasons: PublicSeason[]): PublicSeason[] {
  return [...seasons].sort((left, right) => left.number - right.number);
}

export function orderEpisodes(episodes: PublicEpisode[]): PublicEpisode[] {
  return [...episodes].sort((left, right) => left.number - right.number);
}

export function orderedPlayableEpisodes(seasons: PublicSeason[]): OrderedEpisode[] {
  return orderSeasons(seasons).flatMap((season) =>
    orderEpisodes(season.episodes)
      .filter((episode) => episode.video_url)
      .map((episode) => ({ ...episode, seasonId: season.id, seasonNumber: season.number })),
  );
}
