import { MovieHarborClientError } from '../services/error-mapper.js';

// 单集读写响应可能在封装层或单集内附带父剧集标识，旧响应允许省略该字段。
type EpisodeIdentity = { episode: { id: string; season_id: string; series_id?: string }; series_id?: string };
// 调用方已经解析的完整目标层级，供读取结果与实际请求逐项核对。
type EpisodeTarget = { episode_id: string; season_id: string; series_id: string };

// 单集元数据修改和视频上传收到响应后验证层级归属，身份不符时拒绝继续写入或使用新版本。
export function assertEpisodeIdentity(response: EpisodeIdentity, target: EpisodeTarget): void {
  const episode = response.episode;
  if (episode.id !== target.episode_id || episode.season_id !== target.season_id
    || (response.series_id !== undefined && response.series_id !== target.series_id)
    || (episode.series_id !== undefined && episode.series_id !== target.series_id)) {
    throw new MovieHarborClientError('invalid_response');
  }
}
