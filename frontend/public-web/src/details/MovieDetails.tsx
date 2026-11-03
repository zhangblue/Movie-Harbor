import { useCallback } from "react";
import { getMovieDetail } from "@movie-harbor/api-client";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { DetailsLayout } from "./DetailsLayout";

// 由应用路由渲染电影详情并请求公开数据。
export function MovieDetails({ id }: { id: string }) {
  // 内容标识变化时重新读取电影详情，供请求状态 Hook 渲染结果或错误。
  const load = useCallback(() => getMovieDetail(id), [id]);
  const { state, retry } = usePublicRequest(load);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RequestError error={state.error} retry={retry} />;
  return <DetailsLayout detail={state.data}>
    {state.data.video_url ? <a className="play-button" href={`/movies/${encodeURIComponent(id)}/play`} aria-label="播放电影">▶ 播放</a> : <p>暂无可播放视频。</p>}
  </DetailsLayout>;
}
