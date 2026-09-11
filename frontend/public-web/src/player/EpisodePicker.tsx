import { useState } from "react";
import type { PublicEpisode, PublicSeason } from "@movie-harbor/api-client";

export interface OrderedEpisode extends PublicEpisode { seasonId: string; seasonNumber: number }

export function orderedPlayableEpisodes(seasons: PublicSeason[]): OrderedEpisode[] {
  return [...seasons]
    .sort((a, b) => a.number - b.number)
    .flatMap((season) => [...season.episodes]
      .sort((a, b) => a.number - b.number)
      .filter((episode) => episode.video_url)
      .map((episode) => ({ ...episode, seasonId: season.id, seasonNumber: season.number })));
}

export function EpisodePicker({ seasons, current, select }: {
  seasons: PublicSeason[];
  current: OrderedEpisode;
  select: (episode: OrderedEpisode) => void;
}) {
  const orderedSeasons = [...seasons].sort((a, b) => a.number - b.number);
  const [pickedSeason, setPickedSeason] = useState<{ episodeId: string; number: number } | null>(null);
  const seasonNumber = pickedSeason?.episodeId === current.id ? pickedSeason.number : current.seasonNumber;
  const episodes = orderedPlayableEpisodes(orderedSeasons).filter((item) => item.seasonNumber === seasonNumber);
  return <aside className="episode-picker" aria-labelledby="episode-picker-title">
    <h2 id="episode-picker-title">选集</h2>
    <div className="season-switch" role="group" aria-label="选择季">
      {orderedSeasons.map((season) => <button key={season.id} type="button"
        className={`pill${seasonNumber === season.number ? " is-active" : ""}`}
        aria-pressed={seasonNumber === season.number}
        onClick={() => setPickedSeason({ episodeId: current.id, number: season.number })}>第 {season.number} 季</button>)}
    </div>
    <div className="episode-picker-list">
      {episodes.map((episode) => <button key={episode.id} type="button"
        className={episode.id === current.id ? "is-current" : ""}
        aria-current={episode.id === current.id ? "true" : undefined}
        onClick={() => { setPickedSeason(null); select(episode); }}>
        第 {episode.number} 集 · {episode.name}
      </button>)}
    </div>
  </aside>;
}
