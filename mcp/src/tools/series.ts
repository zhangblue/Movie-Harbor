import type { McpServer } from '@modelcontextprotocol/server';
import type { MovieHarborClient } from '../services/movie-harbor-client.js';
import { MovieHarborClientError } from '../services/error-mapper.js';
import { parseApi, writeAnnotations, toolResult, contentResult } from '../schemas/common.js';
import { createSeriesInput, createSeriesOutput, createSeasonInput, createSeasonOutput, createEpisodeInput, episodeOutput, updateSeriesInput, updateEpisodeInput, apiSeries, apiEpisodeEnvelope } from '../schemas/content.js';

export async function createSeries(input: unknown, client: MovieHarborClient) {
  const { visibility, confirmed: _confirmed, ...metadata } = createSeriesInput.parse(input);
  const is_private = visibility === 'private';
  const series = parseApi(apiSeries, await client.json('POST', '/api/admin/series', { ...metadata, is_private }));
  if (series.is_private !== is_private) throw new MovieHarborClientError('invalid_response');
  return toolResult(createSeriesOutput, { id: series.id, version: series.version, status: series.status, next_actions: ['create_season'] }, `已创建完整${is_private ? '私密' : '公开'}剧集草稿。`);
}
export async function createSeason(input: unknown, client: MovieHarborClient) {
  const { series_id, confirmed: _confirmed, ...body } = createSeasonInput.parse(input);
  const series = parseApi(apiSeries, await client.json('POST', `/api/admin/series/${series_id}/seasons`, body));
  const seasons = series.seasons.filter(season => season.number === body.number);
  if (series.id !== series_id || seasons.length !== 1) throw new MovieHarborClientError('invalid_response');
  return toolResult(createSeasonOutput, { series_id, series_version: series.version, season_id: seasons[0]!.id, next_actions: ['create_episode'] }, '已创建季，请使用最新剧集版本继续操作。');
}
export async function createEpisode(input: unknown, client: MovieHarborClient) {
  const { series_id, season_id, confirmed: _confirmed, ...body } = createEpisodeInput.parse(input);
  const response = parseApi(apiSeries, await client.json('POST', `/api/admin/series/${series_id}/seasons/${season_id}/episodes`, body));
  const seasons = response.seasons.filter(season => season.id === season_id);
  if (response.id !== series_id || seasons.length !== 1) throw new MovieHarborClientError('invalid_response');
  const episodes = seasons[0]!.episodes.filter(episode => episode.number === body.number);
  if (episodes.length !== 1) throw new MovieHarborClientError('invalid_response');
  const created = episodes[0]!;
  return toolResult(episodeOutput, { id: created.id, version: created.version, status: created.status, series_version: response.version,
    next_actions: ['upload_episode_video'] }, '已创建具名、含时长的单集草稿。');
}
export async function updateSeriesMetadata(input: unknown, client: MovieHarborClient) {
  const { series_id, ...patch } = updateSeriesInput.parse(input);
  const series = parseApi(apiSeries, await client.json('PATCH', `/api/admin/series/${series_id}`, patch));
  if (series.id !== series_id) throw new MovieHarborClientError('invalid_response');
  return toolResult(contentResult, { id: series.id, version: series.version, status: series.status, next_actions: ['get_series_structure'] }, '已更新剧集元数据。');
}
export async function updateEpisodeMetadata(input: unknown, client: MovieHarborClient) {
  const { series_id, season_id, episode_id, ...patch } = updateEpisodeInput.parse(input);
  const response = parseApi(apiEpisodeEnvelope, await client.json('PATCH', `/api/admin/series/${series_id}/seasons/${season_id}/episodes/${episode_id}`, patch));
  const episode = response.episode;
  if (episode.id !== episode_id || episode.season_id !== season_id
    || (response.series_id !== undefined && response.series_id !== series_id)
    || (episode.series_id !== undefined && episode.series_id !== series_id)) throw new MovieHarborClientError('invalid_response');
  return toolResult(episodeOutput, { id: episode.id, version: episode.version, status: episode.status, series_version: response.series_version,
    next_actions: episode.video ? ['replace_episode_video', 'publish_episode'] : ['upload_episode_video'] }, '已更新单集元数据。');
}
export function registerSeriesTools(server: McpServer, client: MovieHarborClient) {
  server.registerTool('create_series', { description: '创建完整剧集草稿，必须提供非空简介、年代、题材和暂存海报 token，并携带入库确认 confirmed: true；访问范围默认公开，可显式选择私密；不隐式创建季或单集。', inputSchema: createSeriesInput, outputSchema: createSeriesOutput, annotations: writeAnnotations }, input => createSeries(input, client));
  server.registerTool('create_season', { description: '按剧集 ID 和版本显式创建一个季，必须携带入库确认 confirmed: true；访问范围继承整剧；已归档剧集停止并由管理员处理。', inputSchema: createSeasonInput, outputSchema: createSeasonOutput, annotations: writeAnnotations }, input => createSeason(input, client));
  server.registerTool('create_episode', { description: '按剧集版本在明确季下创建单集草稿，必须提供非空单集名称、秒数时长和入库确认 confirmed: true；访问范围继承整剧；已归档父剧集停止并由管理员处理。', inputSchema: createEpisodeInput, outputSchema: episodeOutput, annotations: writeAnnotations }, input => createEpisode(input, client));
  server.registerTool('update_series_metadata', { description: '按剧集 ID 和版本仅更新提交的元数据字段。', inputSchema: updateSeriesInput, outputSchema: contentResult, annotations: writeAnnotations }, input => updateSeriesMetadata(input, client));
  server.registerTool('update_episode_metadata', { description: '按明确剧集、季、单集 ID 和单集版本仅更新元数据。', inputSchema: updateEpisodeInput, outputSchema: episodeOutput, annotations: writeAnnotations }, input => updateEpisodeMetadata(input, client));
}
