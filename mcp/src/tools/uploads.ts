import type { McpServer } from '@modelcontextprotocol/server';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { id, confirmed, parseApi, positiveInt, toolResult, version, writeAnnotations } from '../schemas/common.js';
import { apiEpisodeEnvelope, apiMovie } from '../schemas/content.js';
import { deleteGeneratedFile } from '../services/generated-files.js';
import { inspectVideo, serializeIdentity } from '../services/media-inspector.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';
import { inspectAllowedFile } from '../services/path-policy.js';
import type { LocalMediaDependencies } from './local-media.js';

// 上传输入仅接受绝对路径；实际读取前还会验证目录、文件身份和视频兼容性。
const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
// 电影上传必须显式提供内容版本和入库确认，防止对过时目标写入。
export const uploadMovieVideoInput = z.strictObject({ movie_id: id, version, path: localPath, confirmed });
// 替换电影视频复用同一输入边界，是否已有视频由工具另外核对。
export const replaceMovieVideoInput = uploadMovieVideoInput;
// 单集上传携带完整层级及单集版本，供远端归属和并发检查使用。
export const uploadEpisodeVideoInput = z.strictObject({ series_id: id, season_id: id, episode_id: id, version, path: localPath, confirmed });
// 替换单集视频复用上传输入，替换意图由独立工具入口表达。
export const replaceEpisodeVideoInput = uploadEpisodeVideoInput;
// 上传结果向调用方报告媒体元数据、生成文件清理结果及仍需确认的后续动作。
const uploadFields = { id, version, media_id: id, mime_type: z.enum(['video/mp4', 'video/webm']), byte_size: z.number().int().nonnegative(),
  generated_file_deleted: z.boolean(), retained_generated_path: z.string().nullable(), next_actions: z.array(z.string()) };
// 电影上传返回内容的新版本，供后续独立发布使用。
export const movieUploadOutput = z.object(uploadFields);
// 单集上传还返回父剧集新版本，避免后续层级操作沿用旧版本。
export const episodeUploadOutput = z.object({ ...uploadFields, series_version: version });
// 校验管理 API 原子上传返回的媒体身份、格式、大小及内容版本。
const apiMovieUpload = z.object({ id, mime_type: z.enum(['video/mp4', 'video/webm']), byte_size: z.number().int().nonnegative(), version: positiveInt });
// 单集原子上传响应必须另外包含父级版本。
const apiEpisodeUpload = apiMovieUpload.extend({ series_version: version });

// 描述上传工具所需客户端和媒体检查依赖。
export interface UploadDependencies extends LocalMediaDependencies { client: MovieHarborClient }

// 判断上传文件是否位于指定生成目录。
function inside(root: string, path: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child.split(sep)[0] !== '..';
}

// 上传前检查文件身份、格式和兼容性。
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

// 上传前核对目标草稿状态和版本。
function assertDraftTarget(target: { status: string; version: number }, expectedVersion: number) {
  if (target.status === 'archived') throw new Error('目标已归档，请由管理员处理，MCP 不会恢复草稿');
  if (target.status !== 'draft') throw new Error('只有草稿内容可以上传或替换视频');
  if (target.version !== expectedVersion) throw new MovieHarborClientError('version_conflict', 409);
}

// 上传成功后仅清理已登记的生成文件。
async function cleanupAfterUpload(path: string, generated: boolean, dependencies: UploadDependencies) {
  if (!generated) return { generated_file_deleted: false, retained_generated_path: null };
  try {
    await deleteGeneratedFile(path, dependencies.config, dependencies.credentialDirectory);
    return { generated_file_deleted: true, retained_generated_path: null };
  } catch {
    return { generated_file_deleted: false, retained_generated_path: path };
  }
}

// 描述上传前校验通过的视频及元数据。
type CheckedVideo = Awaited<ReturnType<typeof checkedVideo>>;

// 上传已检查文件并校验响应后处理生成文件。
async function uploadFile<T>(checked: CheckedVideo, endpoint: string, dependencies: UploadDependencies,
  parser: (value: unknown, checked: Awaited<ReturnType<typeof checkedVideo>>) => T) {
  let raw: unknown;
  try { raw = await dependencies.client.upload(endpoint, checked.file, checked.mimeType); }
  catch (error) {
    if (checked.generated) throw new Error(`视频上传失败或结果未知；生成文件已保留，请重新查询目标后重试：${checked.file.realPath}`);
    throw error;
  }
  // 清理前先解析并交叉核对：结构合法但版本或文件信息不符时仍视为提交结果未知。
  const response = parser(raw, checked);
  // 仅在服务端结果通过校验后清理生成文件；失败时保留文件供重试。
  return { response, ...(await cleanupAfterUpload(checked.file.realPath, checked.generated, dependencies)) };
}

// 确认入库后上传或替换指定电影视频。
export async function uploadMovieVideo(input: unknown, dependencies: UploadDependencies, replace = false) {
  const parsed = (replace ? replaceMovieVideoInput : uploadMovieVideoInput).parse(input);
  // 本地兼容性先通过才查询远端；远端草稿、版本与替换意图全部匹配后才上传。
  const checked = await checkedVideo(parsed.path, dependencies);
  const movie = parseApi(apiMovie, await dependencies.client.json('GET', `/api/admin/movies/${parsed.movie_id}`));
  if (movie.id !== parsed.movie_id) throw new MovieHarborClientError('invalid_response');
  assertDraftTarget(movie, parsed.version);
  if (!replace && movie.video) throw new Error('目标已有视频，请改用 replace_movie_video 并明确确认替换');
  if (replace && !movie.video) throw new Error('目标没有视频，请改用 upload_movie_video');
  const result = await uploadFile(checked, `/api/admin/media/movies/${parsed.movie_id}/video?version=${parsed.version}`,
    dependencies, (value, checked) => {
      // 上传响应必须对应本次文件且只推进一个版本，否则不允许清理本地生成文件。
      const response = parseApi(apiMovieUpload, value);
      if (response.mime_type !== checked.mimeType || response.byte_size !== checked.file.identity.size
        || response.version !== parsed.version + 1) throw new MovieHarborClientError('invalid_response');
      return response;
    });
  return toolResult(movieUploadOutput, { id: parsed.movie_id, version: result.response.version, media_id: result.response.id,
    mime_type: result.response.mime_type, byte_size: result.response.byte_size, generated_file_deleted: result.generated_file_deleted,
    retained_generated_path: result.retained_generated_path, next_actions: ['publish_movie'] },
  replace ? '电影视频已明确替换；发布仍需单独确认。' : '电影视频已上传；发布仍需单独确认。');
}

// 确认入库后上传或替换指定单集视频。
export async function uploadEpisodeVideo(input: unknown, dependencies: UploadDependencies, replace = false) {
  const parsed = (replace ? replaceEpisodeVideoInput : uploadEpisodeVideoInput).parse(input);
  // 先拒绝不兼容本地文件，再确认目标单集归属和版本，避免写入错误层级。
  const checked = await checkedVideo(parsed.path, dependencies);
  const detailPath = `/api/admin/series/${parsed.series_id}/seasons/${parsed.season_id}/episodes/${parsed.episode_id}`;
  const envelope = parseApi(apiEpisodeEnvelope, await dependencies.client.json('GET', detailPath));
  const episode = envelope.episode;
  if (episode.id !== parsed.episode_id || episode.season_id !== parsed.season_id
    || (envelope.series_id !== undefined && envelope.series_id !== parsed.series_id)
    || (episode.series_id !== undefined && episode.series_id !== parsed.series_id)) throw new MovieHarborClientError('invalid_response');
  assertDraftTarget(episode, parsed.version);
  if (!replace && episode.video) throw new Error('目标已有视频，请改用 replace_episode_video 并明确确认替换');
  if (replace && !episode.video) throw new Error('目标没有视频，请改用 upload_episode_video');
  const result = await uploadFile(checked, `/api/admin/media/episodes/${parsed.episode_id}/video?version=${parsed.version}`,
    dependencies, (value, checked) => {
      // 同时核对媒体元数据、单集和父剧集的版本增量，任何不一致都保留生成文件。
      const response = parseApi(apiEpisodeUpload, value);
      if (response.mime_type !== checked.mimeType || response.byte_size !== checked.file.identity.size
        || response.version !== parsed.version + 1 || response.series_version !== envelope.series_version + 1) {
        throw new MovieHarborClientError('invalid_response');
      }
      return response;
    });
  return toolResult(episodeUploadOutput, { id: parsed.episode_id, version: result.response.version,
    series_version: result.response.series_version, media_id: result.response.id, mime_type: result.response.mime_type,
    byte_size: result.response.byte_size, generated_file_deleted: result.generated_file_deleted,
    retained_generated_path: result.retained_generated_path, next_actions: ['publish_episode'] },
  replace ? '单集视频已明确替换；发布仍需单独确认。' : '单集视频已上传；发布仍需单独确认。');
}

// 构建服务器时注册上传和明确替换工具。
export function registerUploadTools(server: McpServer, dependencies: UploadDependencies) {
  // 注册 upload_movie_video：携带入库确认 confirmed: true 后向空电影视频槽流式上传兼容文件；发布仍需独立确认。
  server.registerTool('upload_movie_video', { description:'携带入库确认 confirmed: true 后向空电影视频槽流式上传兼容文件；发布仍需独立确认。',inputSchema:uploadMovieVideoInput,outputSchema:movieUploadOutput,annotations:writeAnnotations }, input=>uploadMovieVideo(input,dependencies));
  // 注册 replace_movie_video：携带入库确认 confirmed: true 后流式替换电影视频，入库计划必须列明替换副作用；发布仍需独立确认。
  server.registerTool('replace_movie_video', { description:'携带入库确认 confirmed: true 后流式替换电影视频，入库计划必须列明替换副作用；发布仍需独立确认。',inputSchema:replaceMovieVideoInput,outputSchema:movieUploadOutput,annotations:writeAnnotations }, input=>uploadMovieVideo(input,dependencies,true));
  // 注册 upload_episode_video：携带入库确认 confirmed: true 后向空单集视频槽流式上传兼容文件；发布仍需独立确认。
  server.registerTool('upload_episode_video', { description:'携带入库确认 confirmed: true 后向空单集视频槽流式上传兼容文件；发布仍需独立确认。',inputSchema:uploadEpisodeVideoInput,outputSchema:episodeUploadOutput,annotations:writeAnnotations }, input=>uploadEpisodeVideo(input,dependencies));
  // 注册 replace_episode_video：携带入库确认 confirmed: true 后流式替换单集视频，入库计划必须列明替换副作用；发布仍需独立确认。
  server.registerTool('replace_episode_video', { description:'携带入库确认 confirmed: true 后流式替换单集视频，入库计划必须列明替换副作用；发布仍需独立确认。',inputSchema:replaceEpisodeVideoInput,outputSchema:episodeUploadOutput,annotations:writeAnnotations }, input=>uploadEpisodeVideo(input,dependencies,true));
}
