import { useCallback, useState } from "react";
import { getSeriesDetail } from "@movie-harbor/api-client";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { DetailsLayout, durationLabel } from "./DetailsLayout";

export function SeriesDetails({ id }: { id: string }) {
  const load = useCallback(() => getSeriesDetail(id), [id]);
  const { state, retry } = usePublicRequest(load);
  const [selectedSeason, setSelectedSeason] = useState<string>();
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RequestError error={state.error} retry={retry} />;
  // The public endpoint already enforces publication visibility; never infer or synthesize missing episodes.
  const seasons = [...state.data.seasons].sort((a, b) => a.number - b.number);
  const season = seasons.find((item) => item.id === selectedSeason) ?? seasons[0];
  const episodes = [...(season?.episodes ?? [])].sort((a, b) => a.number - b.number);
  return <>
    <DetailsLayout detail={state.data}><p>{seasons.length} 季</p></DetailsLayout>
    <section className="series-episodes" aria-labelledby="episodes-title">
      <h2 id="episodes-title">剧集选集</h2>
      <div className="season-switch" role="group" aria-label="选择季">
        {seasons.map((item) => <button type="button" className={`pill${season?.id === item.id ? " is-active" : ""}`}
          aria-pressed={season?.id === item.id} key={item.id} onClick={() => setSelectedSeason(item.id)}>第 {item.number} 季</button>)}
      </div>
      {season && <h3>第 {season.number} 季</h3>}
      {episodes.length ? <ol className="episode-list" aria-label={`第 ${season.number} 季单集`}>
        {episodes.map((episode) => {
          const label = `第 ${episode.number} 集 · ${episode.name}`;
          const duration = durationLabel(episode.duration_seconds);
          return <li key={episode.id}>
            {episode.video_url ? <a className="episode-card" aria-label={`${label}，${duration}`}
              href={`/series/${encodeURIComponent(id)}/play/${encodeURIComponent(episode.id)}`}>
              <span className="episode-name">{label}</span><span className="episode-duration">{duration}</span>
            </a> : <div className="episode-card is-unavailable">
              <span className="episode-name">{label}（暂无可播放视频）</span><span className="episode-duration">{duration}</span>
            </div>}
          </li>;
        })}
      </ol> : <p className="empty-state">暂无公开单集。</p>}
    </section>
  </>;
}
