import { useState } from "react";
import type { PublicSeason } from "@movie-harbor/api-client";
import { orderedPlayableEpisodes, orderSeasons, type OrderedEpisode } from "../series/ordering";

export function EpisodePicker({ seasons, current, select }: {
  seasons: PublicSeason[];
  current: OrderedEpisode;
  select: (episode: OrderedEpisode) => void;
}) {
  const orderedSeasons = orderSeasons(seasons);
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
