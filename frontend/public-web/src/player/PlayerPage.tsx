import { useCallback, useEffect } from "react";
import { getMovieDetail, getSeriesDetail, type SeriesDetail } from "@movie-harbor/api-client";
import { Loading, NotFound, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { EpisodePicker, orderedPlayableEpisodes, type OrderedEpisode } from "./EpisodePicker";
import { getRecentEpisode, setRecentEpisode } from "./progressStore";
import { VideoPlayer } from "./VideoPlayer";

type Navigate = (href: string, replace?: boolean) => void;

export function MoviePlayerPage({ id }: { id: string }) {
  const load = useCallback(() => getMovieDetail(id), [id]);
  const { state, retry } = usePublicRequest(load);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RequestError error={state.error} retry={retry} />;
  if (!state.data.video_url) return <NotFound />;
  return <section className="player-page">
    <a className="back-link" href={`/movies/${encodeURIComponent(id)}`}>返回电影详情</a>
    <div className="player-layout">
      <div>
        <VideoPlayer contentKey={`movie:${id}`} src={state.data.video_url} title={`播放 ${state.data.name}`} />
        <h1>{state.data.name}</h1>
      </div>
    </div>
  </section>;
}

export function SeriesPlayerPage({ id, episodeId, navigate }: {
  id: string;
  episodeId?: string;
  navigate: Navigate;
}) {
  const load = useCallback(() => getSeriesDetail(id), [id]);
  const { state, retry } = usePublicRequest(load);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RequestError error={state.error} retry={retry} />;
  return <LoadedSeriesPlayer detail={state.data} episodeId={episodeId} navigate={navigate} />;
}

function LoadedSeriesPlayer({ detail, episodeId, navigate }: {
  detail: SeriesDetail;
  episodeId?: string;
  navigate: Navigate;
}) {
  const episodes = orderedPlayableEpisodes(detail.seasons);
  const recentId = getRecentEpisode(`series:${detail.id}`);
  const selected = episodeId
    ? episodes.find((episode) => episode.id === episodeId)
    : episodes.find((episode) => episode.id === recentId) ?? episodes[0];

  useEffect(() => {
    if (!episodeId && selected) navigate(seriesPlaybackPath(detail.id, selected.id), true);
  }, [detail.id, episodeId, navigate, selected?.id]);
  useEffect(() => {
    if (selected) setRecentEpisode(`series:${detail.id}`, selected.id);
  }, [detail.id, selected?.id]);

  if (!selected?.video_url) return <NotFound />;
  const currentIndex = episodes.findIndex((episode) => episode.id === selected.id);
  const choose = (episode: OrderedEpisode) => {
    setRecentEpisode(`series:${detail.id}`, episode.id);
    navigate(seriesPlaybackPath(detail.id, episode.id));
  };
  return <section className="player-page">
    <a className="back-link" href={`/series/${encodeURIComponent(detail.id)}`}>返回剧集详情</a>
    <div className="player-layout">
      <div>
        <VideoPlayer key={selected.id} contentKey={`episode:${selected.id}`} src={selected.video_url}
          title={`播放 ${detail.name} 第 ${selected.number} 集 ${selected.name}`} />
        <p className="eyebrow">{detail.name} · 第 {selected.seasonNumber} 季</p>
        <h1>第 {selected.number} 集 · {selected.name}</h1>
        <div className="episode-navigation">
          <button type="button" className="pill" disabled={currentIndex === 0} onClick={() => choose(episodes[currentIndex - 1]!)}>上一集</button>
          <button type="button" className="pill" disabled={currentIndex === episodes.length - 1} onClick={() => choose(episodes[currentIndex + 1]!)}>下一集</button>
        </div>
      </div>
      <EpisodePicker key={selected.id} seasons={detail.seasons} current={selected} select={choose} />
    </div>
  </section>;
}

function seriesPlaybackPath(seriesId: string, episodeId: string) {
  return `/series/${encodeURIComponent(seriesId)}/play/${encodeURIComponent(episodeId)}`;
}
