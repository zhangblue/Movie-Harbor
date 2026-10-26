import type { McpServer } from '@modelcontextprotocol/server';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { id, parseApi, positiveInt, toolResult, version, writeAnnotations } from '../schemas/common.js';
import { apiEpisodeEnvelope, apiMovie } from '../schemas/content.js';
import { deleteGeneratedFile } from '../services/generated-files.js';
import { inspectVideo, serializeIdentity } from '../services/media-inspector.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';
import { inspectAllowedFile } from '../services/path-policy.js';
import type { LocalMediaDependencies } from './local-media.js';

const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
export const uploadMovieVideoInput = z.strictObject({ movie_id: id, version, path: localPath });
export const replaceMovieVideoInput = uploadMovieVideoInput.extend({ confirmed: z.boolean() });
export const uploadEpisodeVideoInput = z.strictObject({ series_id: id, season_id: id, episode_id: id, version, path: localPath });
export const replaceEpisodeVideoInput = uploadEpisodeVideoInput.extend({ confirmed: z.boolean() });
const uploadFields = { id, version, media_id: id, mime_type: z.enum(['video/mp4', 'video/webm']), byte_size: z.number().int().nonnegative(),
  generated_file_deleted: z.boolean(), retained_generated_path: z.string().nullable(), next_actions: z.array(z.string()) };
export const movieUploadOutput = z.object(uploadFields);
export const episodeUploadOutput = z.object({ ...uploadFields, series_version: version });
const apiMovieUpload = z.object({ id, mime_type: z.enum(['video/mp4', 'video/webm']), byte_size: z.number().int().nonnegative(), version: positiveInt });
const apiEpisodeUpload = apiMovieUpload.extend({ series_version: version });

export interface UploadDependencies extends LocalMediaDependencies { client: MovieHarborClient }

function inside(root: string, path: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child.split(sep)[0] !== '..';
}

async function checkedVideo(path: string, dependencies: UploadDependencies) {
  const generated = inside(dependencies.config.generatedRoot, path);
  const roots = generated ? [dependencies.config.generatedRoot] : dependencies.config.allowedRoots;
  const inspected = await inspectVideo(path, roots, dependencies.probeMedia, dependencies.buildConversionPlan);
  if (!inspected.compatibility.accepted || !['mp4', 'webm'].includes(inspected.container)) {
    throw new Error('视频格式不符合网站要求，请先调用 convert_video 并单独确认转换');
  }
  const file = await inspectAllowedFile(path, roots);
  const identity = serializeIdentity(file);
  for (const field of ['dev', 'ino', 'size', 'mtime_ms'] as const) {
    if (identity[field] !== inspected.identity[field]) throw new MovieHarborClientError('file_changed');
  }
  return { file, generated, mimeType: inspected.container === 'mp4' ? 'video/mp4' as const : 'video/webm' as const };
}

function assertDraftTarget(target: { status: string; version: number }, expectedVersion: number) {
  if (target.status === 'archived') throw new Error('目标已归档，请由管理员处理，MCP 不会恢复草稿');
  if (target.status !== 'draft') throw new Error('只有草稿内容可以上传或替换视频');
  if (target.version !== expectedVersion) throw new MovieHarborClientError('version_conflict', 409);
}

async function cleanupAfterUpload(path: string, generated: boolean, dependencies: UploadDependencies) {
  if (!generated) return { generated_file_deleted: false, retained_generated_path: null };
  try {
    await deleteGeneratedFile(path, dependencies.config, dependencies.credentialDirectory);
    return { generated_file_deleted: true, retained_generated_path: null };
  } catch {
    return { generated_file_deleted: false, retained_generated_path: path };
  }
}

async function uploadFile<T>(path: string, endpoint: string, dependencies: UploadDependencies, parser: (value: unknown) => T) {
  const checked = await checkedVideo(path, dependencies);
  let response: T;
  try { response = parser(await dependencies.client.upload(endpoint, checked.file, checked.mimeType)); }
  catch (error) {
    if (checked.generated) throw new Error(`视频上传失败或结果未知；生成文件已保留，请重新查询目标后重试：${checked.file.realPath}`);
    throw error;
  }
  return { response, ...(await cleanupAfterUpload(checked.file.realPath, checked.generated, dependencies)) };
}

export async function uploadMovieVideo(input: unknown, dependencies: UploadDependencies, replace = false) {
  const parsed = (replace ? replaceMovieVideoInput : uploadMovieVideoInput).parse(input);
  if (replace && 'confirmed' in parsed && parsed.confirmed !== true) throw new Error('替换已有视频需要明确确认替换');
  const movie = parseApi(apiMovie, await dependencies.client.json('GET', `/api/admin/movies/${parsed.movie_id}`));
  if (movie.id !== parsed.movie_id) throw new MovieHarborClientError('invalid_response');
  assertDraftTarget(movie, parsed.version);
  if (!replace && movie.video) throw new Error('目标已有视频，请改用 replace_movie_video 并明确确认替换');
  if (replace && !movie.video) throw new Error('目标没有视频，请改用 upload_movie_video');
  const result = await uploadFile(parsed.path, `/api/admin/media/movies/${parsed.movie_id}/video?version=${parsed.version}`,
    dependencies, value => parseApi(apiMovieUpload, value));
  return toolResult(movieUploadOutput, { id: parsed.movie_id, version: result.response.version, media_id: result.response.id,
    mime_type: result.response.mime_type, byte_size: result.response.byte_size, generated_file_deleted: result.generated_file_deleted,
    retained_generated_path: result.retained_generated_path, next_actions: ['publish_movie'] },
  replace ? '电影视频已明确替换；发布仍需单独确认。' : '电影视频已上传；发布仍需单独确认。');
}

export async function uploadEpisodeVideo(input: unknown, dependencies: UploadDependencies, replace = false) {
  const parsed = (replace ? replaceEpisodeVideoInput : uploadEpisodeVideoInput).parse(input);
  if (replace && 'confirmed' in parsed && parsed.confirmed !== true) throw new Error('替换已有视频需要明确确认替换');
  const detailPath = `/api/admin/series/${parsed.series_id}/seasons/${parsed.season_id}/episodes/${parsed.episode_id}`;
  const envelope = parseApi(apiEpisodeEnvelope, await dependencies.client.json('GET', detailPath));
  const episode = envelope.episode;
  if (episode.id !== parsed.episode_id || episode.season_id !== parsed.season_id
    || (envelope.series_id !== undefined && envelope.series_id !== parsed.series_id)
    || (episode.series_id !== undefined && episode.series_id !== parsed.series_id)) throw new MovieHarborClientError('invalid_response');
  assertDraftTarget(episode, parsed.version);
  if (!replace && episode.video) throw new Error('目标已有视频，请改用 replace_episode_video 并明确确认替换');
  if (replace && !episode.video) throw new Error('目标没有视频，请改用 upload_episode_video');
  const result = await uploadFile(parsed.path, `/api/admin/media/episodes/${parsed.episode_id}/video?version=${parsed.version}`,
    dependencies, value => parseApi(apiEpisodeUpload, value));
  return toolResult(episodeUploadOutput, { id: parsed.episode_id, version: result.response.version,
    series_version: result.response.series_version, media_id: result.response.id, mime_type: result.response.mime_type,
    byte_size: result.response.byte_size, generated_file_deleted: result.generated_file_deleted,
    retained_generated_path: result.retained_generated_path, next_actions: ['publish_episode'] },
  replace ? '单集视频已明确替换；发布仍需单独确认。' : '单集视频已上传；发布仍需单独确认。');
}

export function registerUploadTools(server: McpServer, dependencies: UploadDependencies) {
  server.registerTool('upload_movie_video', { description:'向空电影视频槽流式上传兼容文件；不会发布。',inputSchema:uploadMovieVideoInput,outputSchema:movieUploadOutput,annotations:writeAnnotations }, input=>uploadMovieVideo(input,dependencies));
  server.registerTool('replace_movie_video', { description:'经明确确认后流式替换电影视频；不会发布。',inputSchema:replaceMovieVideoInput,outputSchema:movieUploadOutput,annotations:writeAnnotations }, input=>uploadMovieVideo(input,dependencies,true));
  server.registerTool('upload_episode_video', { description:'向空单集视频槽流式上传兼容文件；不会发布。',inputSchema:uploadEpisodeVideoInput,outputSchema:episodeUploadOutput,annotations:writeAnnotations }, input=>uploadEpisodeVideo(input,dependencies));
  server.registerTool('replace_episode_video', { description:'经明确确认后流式替换单集视频；不会发布。',inputSchema:replaceEpisodeVideoInput,outputSchema:episodeUploadOutput,annotations:writeAnnotations }, input=>uploadEpisodeVideo(input,dependencies,true));
}
