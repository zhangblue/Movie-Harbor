import type { McpServer } from '@modelcontextprotocol/server';
import type { MovieHarborClient } from '../services/movie-harbor-client.js';
import { MovieHarborClientError } from '../services/error-mapper.js';
import { validatePoster, serializeIdentity } from '../services/media-inspector.js';
import { inspectAllowedFile } from '../services/path-policy.js';
import { parseApi, writeAnnotations, toolResult, contentResult } from '../schemas/common.js';
import { stagePosterInput, stagePosterOutput, apiStagedPoster, createMovieInput, createMovieOutput, updateMovieInput, apiMovie } from '../schemas/content.js';

export interface MovieToolDependencies { client: MovieHarborClient; allowedRoots: string[] }
export async function stagePoster(input: unknown, dependencies: MovieToolDependencies) {
  const { path } = stagePosterInput.parse(input);
  const checkedPoster = await validatePoster(path, dependencies.allowedRoots);
  const file = await inspectAllowedFile(path, dependencies.allowedRoots);
  const currentIdentity = serializeIdentity(file);
  for (const field of ['dev', 'ino', 'size', 'mtime_ms'] as const) {
    if (currentIdentity[field] !== checkedPoster.identity[field]) throw new MovieHarborClientError('file_changed');
  }
  const staged = parseApi(apiStagedPoster, await dependencies.client.upload('/api/admin/media/posters/stage', file, checkedPoster.mime_type));
  return toolResult(stagePosterOutput, { staged_poster_token: staged.token, format: staged.format, byte_size: staged.byte_size, expires_at: staged.expires_at,
    next_actions: ['create_movie', 'create_series'] }, '海报已暂存，请在有效期内显式创建内容。');
}
export async function createMovie(input: unknown, client: MovieHarborClient) {
  const parsed = createMovieInput.parse(input);
  const movie = parseApi(apiMovie, await client.json('POST', '/api/admin/movies', { ...parsed, is_private: true }));
  return toolResult(createMovieOutput, { id: movie.id, version: movie.version, status: movie.status, next_actions: ['upload_movie_video'] }, '已创建完整私密电影草稿。');
}
export async function updateMovieMetadata(input: unknown, client: MovieHarborClient) {
  const { movie_id, ...patch } = updateMovieInput.parse(input);
  const movie = parseApi(apiMovie, await client.json('PATCH', `/api/admin/movies/${movie_id}`, patch));
  return toolResult(contentResult, { id: movie.id, version: movie.version, status: movie.status,
    next_actions: movie.video ? ['replace_movie_video', 'publish_movie'] : ['upload_movie_video'] }, '已更新电影元数据。');
}
export function registerMovieTools(server: McpServer, dependencies: MovieToolDependencies) {
  server.registerTool('stage_poster', { description: '验证并暂存一个本地海报，返回有期限的创建 token。', inputSchema: stagePosterInput, outputSchema: stagePosterOutput, annotations: writeAnnotations }, input => stagePoster(input, dependencies));
  server.registerTool('create_movie', { description: '仅创建完整私密电影草稿；必须提供年代、时长、题材和暂存海报 token。', inputSchema: createMovieInput, outputSchema: createMovieOutput, annotations: writeAnnotations }, input => createMovie(input, dependencies.client));
  server.registerTool('update_movie_metadata', { description: '按明确电影 ID 和版本仅更新提交的元数据字段。', inputSchema: updateMovieInput, outputSchema: contentResult, annotations: writeAnnotations }, input => updateMovieMetadata(input, dependencies.client));
}
