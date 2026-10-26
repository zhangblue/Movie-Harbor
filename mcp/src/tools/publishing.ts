import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { contentResult, id, parseApi, toolResult, version, writeAnnotations } from '../schemas/common.js';
import { apiEpisodeEnvelope, apiMovie, apiSeries, episodeOutput } from '../schemas/content.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';

export const publishMovieInput = z.strictObject({ movie_id:id, version, confirmed:z.boolean() });
export const publishSeriesInput = z.strictObject({ series_id:id, version, confirmed:z.boolean() });
export const publishEpisodeInput = z.strictObject({ series_id:id, season_id:id, episode_id:id, version, confirmed:z.boolean() });

function requireConfirmation(confirmed: boolean) {
  if (confirmed !== true) throw new Error('需要独立发布确认，入库或转换确认不能代替发布确认');
}
function assertOwned(actual: string, expected: string) {
  if (actual !== expected) throw new MovieHarborClientError('invalid_response');
}
function assertPublishable(status: string, currentVersion: number, expectedVersion: number, label: string) {
  if (status === 'archived') throw new Error(`${label}已归档，请由管理员处理，MCP 不会恢复草稿`);
  if (status === 'draft' && currentVersion !== expectedVersion) throw new MovieHarborClientError('version_conflict',409);
}

export async function publishMovie(input: unknown, client: MovieHarborClient) {
  const parsed=publishMovieInput.parse(input); requireConfirmation(parsed.confirmed);
  const path=`/api/admin/movies/${parsed.movie_id}`;
  const current=parseApi(apiMovie,await client.json('GET',path)); assertOwned(current.id,parsed.movie_id);
  assertPublishable(current.status,current.version,parsed.version,'电影');
  if(current.status==='published') return toolResult(contentResult,{id:current.id,version:current.version,status:current.status,next_actions:[]},'电影已经发布，无需重复操作。');
  const published=parseApi(apiMovie,await client.json('POST',`${path}/publish`,{version:parsed.version}));
  if(published.id!==parsed.movie_id||published.status!=='published'||published.version!==parsed.version+1) throw new MovieHarborClientError('invalid_response');
  return toolResult(contentResult,{id:published.id,version:published.version,status:published.status,next_actions:[]},'电影已发布。');
}

export async function publishSeries(input: unknown, client: MovieHarborClient) {
  const parsed=publishSeriesInput.parse(input); requireConfirmation(parsed.confirmed);
  const path=`/api/admin/series/${parsed.series_id}`;
  const current=parseApi(apiSeries,await client.json('GET',path)); assertOwned(current.id,parsed.series_id);
  assertPublishable(current.status,current.version,parsed.version,'父剧集');
  if(current.status==='published') return toolResult(contentResult,{id:current.id,version:current.version,status:current.status,next_actions:[]},'父剧集已经发布，无需重复操作。');
  const published=parseApi(apiSeries,await client.json('POST',`${path}/publish`,{version:parsed.version}));
  if(published.id!==parsed.series_id||published.status!=='published'||published.version!==parsed.version+1) throw new MovieHarborClientError('invalid_response');
  return toolResult(contentResult,{id:published.id,version:published.version,status:published.status,next_actions:[]},'父剧集已发布。');
}

export async function publishEpisode(input: unknown, client: MovieHarborClient) {
  const parsed=publishEpisodeInput.parse(input); requireConfirmation(parsed.confirmed);
  const parent=parseApi(apiSeries,await client.json('GET',`/api/admin/series/${parsed.series_id}`));
  assertOwned(parent.id,parsed.series_id);
  if(parent.status==='archived') throw new Error('父剧集已归档，请由管理员处理，MCP 不会发布单集或恢复草稿');
  const path=`/api/admin/series/${parsed.series_id}/seasons/${parsed.season_id}/episodes/${parsed.episode_id}`;
  const current=parseApi(apiEpisodeEnvelope,await client.json('GET',path)); const episode=current.episode;
  if(episode.id!==parsed.episode_id||episode.season_id!==parsed.season_id
    ||(current.series_id!==undefined&&current.series_id!==parsed.series_id)
    ||(episode.series_id!==undefined&&episode.series_id!==parsed.series_id)) throw new MovieHarborClientError('invalid_response');
  if(current.series_version!==parent.version) throw new MovieHarborClientError('invalid_response');
  assertPublishable(episode.status,episode.version,parsed.version,'单集');
  const next=parent.status==='draft'?['publish_series']:[];
  if(episode.status==='published') return toolResult(episodeOutput,{id:episode.id,version:episode.version,status:episode.status,
    series_version:current.series_version,next_actions:next},parent.status==='draft'?'单集已经发布；父剧集仍需单独确认发布。':'单集已经发布，无需重复操作。');
  const response=parseApi(apiEpisodeEnvelope,await client.json('POST',`${path}/publish`,{version:parsed.version})); const published=response.episode;
  if(published.id!==parsed.episode_id||published.season_id!==parsed.season_id||published.status!=='published'
    ||published.version!==parsed.version+1||response.series_version!==parent.version+1
    ||(response.series_id!==undefined&&response.series_id!==parsed.series_id)
    ||(published.series_id!==undefined&&published.series_id!==parsed.series_id)) throw new MovieHarborClientError('invalid_response');
  return toolResult(episodeOutput,{id:published.id,version:published.version,status:published.status,
    series_version:response.series_version,next_actions:next},parent.status==='draft'?'单集已发布；父剧集仍需单独确认发布。':'单集已发布。');
}

export function registerPublishingTools(server:McpServer,client:MovieHarborClient){
  server.registerTool('publish_movie',{description:'经独立确认后发布电影；不会修改隐私或其他内容。',inputSchema:publishMovieInput,outputSchema:contentResult,annotations:writeAnnotations},input=>publishMovie(input,client));
  server.registerTool('publish_episode',{description:'经独立确认后仅发布单集；不会自动发布父剧集。',inputSchema:publishEpisodeInput,outputSchema:episodeOutput,annotations:writeAnnotations},input=>publishEpisode(input,client));
  server.registerTool('publish_series',{description:'经独立确认后发布父剧集；必须与单集发布分开调用。',inputSchema:publishSeriesInput,outputSchema:contentResult,annotations:writeAnnotations},input=>publishSeries(input,client));
}
