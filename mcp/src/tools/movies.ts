import type { McpServer } from '@modelcontextprotocol/server';
import type { MovieHarborClient } from '../services/movie-harbor-client.js';
import { MovieHarborClientError } from '../services/error-mapper.js';
import { validatePoster, serializeIdentity } from '../services/media-inspector.js';
import { inspectAllowedFile } from '../services/path-policy.js';
import { parseApi, writeAnnotations, toolResult, contentResult, durationSecondsFromMinutes } from '../schemas/common.js';
import { stagePosterInput, stagePosterOutput, apiStagedPoster, createMovieInput, createMovieOutput, updateMovieInput, apiMovie } from '../schemas/content.js';

// 描述电影工具使用的客户端和本地允许目录。
export interface MovieToolDependencies { client: MovieHarborClient; allowedRoots: string[] }
// 确认入库后验证并暂存用户提供的海报。
export async function stagePoster(input: unknown, dependencies: MovieToolDependencies) {
  const { path, confirmed: _confirmed } = stagePosterInput.parse(input);
  // 本地格式检查通过后再次读取身份；文件变化时不上传，暂存 token 仅供后续显式创建使用。
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
// 确认入库后创建电影草稿并校验返回值。
export async function createMovie(input: unknown, client: MovieHarborClient) {
  const { visibility, confirmed: _confirmed, duration_minutes, ...metadata } = createMovieInput.parse(input);
  const duration_seconds = durationSecondsFromMinutes(duration_minutes);
  const is_private = visibility === 'private';
  // 确认标记和分钟单位留在 MCP 边界处理；只提交 API 字段，并核对保存的范围与秒数。
  const movie = parseApi(apiMovie, await client.json('POST', '/api/admin/movies', { ...metadata, duration_seconds, is_private }));
  if (movie.is_private !== is_private || movie.duration_seconds !== duration_seconds) {
    throw new MovieHarborClientError('invalid_response');
  }
  return toolResult(createMovieOutput, { id: movie.id, version: movie.version, status: movie.status, next_actions: ['upload_movie_video'] }, `已创建完整${is_private ? '私密' : '公开'}电影草稿。`);
}
// 按版本更新电影元数据并校验结果。
export async function updateMovieMetadata(input: unknown, client: MovieHarborClient) {
  const { movie_id, duration_minutes, ...patch } = updateMovieInput.parse(input);
  const duration_seconds = duration_minutes === undefined ? undefined : durationSecondsFromMinutes(duration_minutes);
  // 只发送明确提交的字段和版本；返回 ID 或时长不符时拒绝把结果交给后续上传或发布。
  const movie = parseApi(apiMovie, await client.json('PATCH', `/api/admin/movies/${movie_id}`, {
    ...patch, ...(duration_seconds === undefined ? {} : { duration_seconds }),
  }));
  if (movie.id !== movie_id || (duration_seconds !== undefined && movie.duration_seconds !== duration_seconds)) {
    throw new MovieHarborClientError('invalid_response');
  }
  return toolResult(contentResult, { id: movie.id, version: movie.version, status: movie.status,
    next_actions: movie.video ? ['replace_movie_video', 'publish_movie'] : ['upload_movie_video'] }, '已更新电影元数据。');
}
// 构建服务器时注册海报和电影工具。
export function registerMovieTools(server: McpServer, dependencies: MovieToolDependencies) {
  // 注册 stage_poster：携带入库确认 confirmed: true 后验证并暂存一个本地海报，返回有期限的创建 token。
  server.registerTool('stage_poster', { description: '携带入库确认 confirmed: true 后验证并暂存一个本地海报，返回有期限的创建 token。', inputSchema: stagePosterInput, outputSchema: stagePosterOutput, annotations: writeAnnotations }, input => stagePoster(input, dependencies));
  // 注册 create_movie：创建完整电影草稿；必须提供非空简介、年代、整数分钟时长、题材和暂存海报 token，并携带入库确认 confirmed: true；访问范围默认公开，可显式选择私密。
  server.registerTool('create_movie', { description: '创建完整电影草稿；必须提供非空简介、年代、整数分钟时长、题材和暂存海报 token，并携带入库确认 confirmed: true；访问范围默认公开，可显式选择私密。', inputSchema: createMovieInput, outputSchema: createMovieOutput, annotations: writeAnnotations }, input => createMovie(input, dependencies.client));
  // 注册 update_movie_metadata：按明确电影 ID 和版本仅更新提交的元数据字段；电影时长使用整数分钟。
  server.registerTool('update_movie_metadata', { description: '按明确电影 ID 和版本仅更新提交的元数据字段；电影时长使用整数分钟。', inputSchema: updateMovieInput, outputSchema: contentResult, annotations: writeAnnotations }, input => updateMovieMetadata(input, dependencies.client));
}
