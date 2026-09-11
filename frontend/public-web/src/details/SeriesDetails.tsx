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
      {episodes.length ? <ol className="episode-list">{episodes.map((episode) => <li key={episode.id}>
        <div>{episode.video_url ? <a href={`/series/${encodeURIComponent(id)}/play/${encodeURIComponent(episode.id)}`}>第 {episode.number} 集 · {episode.name}</a>
          : <span>第 {episode.number} 集 · {episode.name}（暂无可播放视频）</span>}
          {episode.synopsis && <p>{episode.synopsis}</p>}</div>
        <span className="episode-duration">{durationLabel(episode.duration_seconds)}</span>
      </li>)}</ol> : <p className="empty-state">暂无公开单集。</p>}
    </section>
  </>;
}
