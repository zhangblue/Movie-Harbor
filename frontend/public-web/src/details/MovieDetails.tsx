import { useCallback } from "react";
import { getMovieDetail } from "@movie-harbor/api-client";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { DetailsLayout } from "./DetailsLayout";

export function MovieDetails({ id }: { id: string }) {
  const load = useCallback(() => getMovieDetail(id), [id]);
  const { state, retry } = usePublicRequest(load);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RequestError error={state.error} retry={retry} />;
  return <DetailsLayout detail={state.data}>
    {state.data.video_url ? <a className="play-button" href={`/movies/${encodeURIComponent(id)}/play`} aria-label="播放电影">▶ 播放</a> : <p>暂无可播放视频。</p>}
  </DetailsLayout>;
}
