import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { id, name, year, duration, durationMinutes, synopsis, visibility, confirmed, version, positiveInt, status, nextActions, contentResult } from './common.js';

// 供创建及更新内容输入要求至少一个且不重复的题材 ID。
const genreIds = z.array(id).min(1).refine(ids => new Set(ids).size === ids.length, '题材 ID 不可重复');
// 供内容创建输入与海报暂存响应校验非空令牌。
const token = z.string().trim().min(1);
// 供海报暂存输入要求不含 NUL 的绝对路径，实际访问仍需目录校验。
const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
// 供电影搜索工具严格接收名称，不接受额外字段。
export const searchMoviesInput = z.strictObject({ name });
// 供剧集搜索工具严格接收名称，不接受额外字段。
export const searchSeriesInput = z.strictObject({ name });
// 供剧集结构工具严格接收剧集 ID。
export const getSeriesStructureInput = z.strictObject({ series_id: id });
// 供题材列表工具只接受空对象。
export const listGenresInput = z.strictObject({});
// 供题材创建工具严格接收名称和入库确认。
export const createGenreInput = z.strictObject({ name, confirmed });
// 供海报暂存工具严格接收本地路径和入库确认。
export const stagePosterInput = z.strictObject({ path: localPath, confirmed });
// 供电影和剧集创建输入复用名称、年份、题材及暂存海报令牌。
const createFields = { name, year, genre_ids: genreIds, staged_poster_token: token };
// 供电影创建工具严格接收完整字段、分钟时长、访问范围和确认。
export const createMovieInput = z.strictObject({ ...createFields, synopsis, duration_minutes: durationMinutes, visibility, confirmed });
// 供剧集创建工具严格接收完整字段、访问范围和确认。
export const createSeriesInput = z.strictObject({ ...createFields, synopsis, visibility, confirmed });
// 供创建季工具严格接收剧集 ID、版本、受限正整数季号和确认。
export const createSeasonInput = z.strictObject({ series_id: id, version, number: positiveInt.max(2_147_483_647), confirmed });
// 供创建单集工具严格接收层级 ID、版本、序号、名称、秒数和确认。
export const createEpisodeInput = z.strictObject({ series_id: id, season_id: id, version, number: positiveInt.max(2_147_483_647), name, duration_seconds: duration, confirmed });
// 供电影与剧集更新输入复用可选元数据字段。
const metadata = { name: name.optional(), synopsis: z.string().optional(), year: year.optional(), genre_ids: genreIds.optional() };
// 供电影更新工具严格接收 ID、版本和至少一个可修改字段，时长为分钟。
export const updateMovieInput = z.strictObject({ movie_id: id, version, ...metadata, duration_minutes: durationMinutes.optional() })
  .refine(value => [value.name, value.synopsis, value.year, value.genre_ids, value.duration_minutes].some(v => v !== undefined), '至少提供一个修改字段');
// 供剧集更新工具严格接收 ID、版本和至少一个可修改元数据字段。
export const updateSeriesInput = z.strictObject({ series_id: id, version, ...metadata })
  .refine(value => [value.name, value.synopsis, value.year, value.genre_ids].some(v => v !== undefined), '至少提供一个修改字段');
// 供单集更新工具严格接收层级 ID、版本及至少一个可修改字段。
export const updateEpisodeInput = z.strictObject({ series_id: id, season_id: id, episode_id: id, version, number: positiveInt.max(2_147_483_647).optional(), name: name.optional(), duration_seconds: duration.optional() })
  .refine(value => [value.number, value.name, value.duration_seconds].some(v => v !== undefined), '至少提供一个修改字段');

// API 解析仅保留声明字段，避免媒体路径和其他未声明响应字段进入工具输出。
// 供内容 API 响应只保留可空媒体 ID，不暴露媒体路径。
const media = z.object({ id }).nullable();
// 供电影和剧集 API 响应复用身份、状态、访问范围和海报字段。
const base = { id, name: z.string(), year: year.nullable(), status, version, is_private: z.boolean(), poster: media };
// 供电影查询、创建和更新校验 API 响应，只保留声明的时长和媒体字段。
export const apiMovie = z.object({ ...base, duration_seconds: duration.nullable(), video: media });
// 供剧集结构及单集工具校验 API 单集字段和可空视频。
export const apiEpisode = z.object({ id, number: positiveInt, name: z.string(), duration_seconds: duration.nullable(), status, version, video: media });
// 供剧集 API 响应校验季标识、序号和单集列表。
export const apiSeason = z.object({ id, number: positiveInt, episodes: z.array(apiEpisode) });
// 供剧集工具校验 API 响应中的基本字段和季列表。
export const apiSeries = z.object({ ...base, seasons: z.array(apiSeason) });
// 供题材工具校验 API 响应，只保留标识、名称和启用状态。
export const apiGenre = z.object({ id, name: z.string(), enabled: z.boolean() });
// 供单集工具校验 API 单集、季归属和父剧集版本。
export const apiEpisodeEnvelope = z.object({ series_version: version, series_id: id.optional(), episode: apiEpisode.extend({ season_id: id, series_id: id.optional() }) });
// 供海报暂存工具校验令牌、格式、大小和过期时间。
export const apiStagedPoster = z.object({ token, format: z.enum(['jpeg','png','webp']), byte_size: z.number().int().nonnegative(), expires_at: z.iso.datetime({ offset: true }) });

// 供电影搜索结果输出过滤候选字段、媒体存在性和精确匹配标记。
const movieMatch = z.object({ id, name: z.string(), year: year.nullable(), duration_minutes: durationMinutes.nullable(), status, version, is_private: z.boolean(), has_poster: z.boolean(), has_video: z.boolean(), exact: z.boolean() });
// 供剧集搜索结果输出过滤候选字段、子级数量和精确匹配标记。
const seriesMatch = z.object({ id, name: z.string(), year: year.nullable(), status, version, is_private: z.boolean(), has_poster: z.boolean(), season_count: z.number().int().nonnegative(), episode_count: z.number().int().nonnegative(), exact: z.boolean() });
// 供电影和剧集搜索输出复用查询、匹配数量、选择要求及后续操作。
const searchFields = { query: z.string(), normalized_name: z.string(), exact_match_count: z.number().int().nonnegative(), requires_selection: z.boolean(), next_actions: nextActions };
// 供电影搜索工具校验候选列表与查询摘要的结构化输出。
export const searchMoviesOutput = z.object({ ...searchFields, matches: z.array(movieMatch) });
// 供剧集搜索工具校验候选列表与查询摘要的结构化输出。
export const searchSeriesOutput = z.object({ ...searchFields, matches: z.array(seriesMatch) });
// 供题材列表工具输出过滤后的题材和后续操作。
export const listGenresOutput = z.object({ genres: z.array(apiGenre), next_actions: nextActions });
// 供题材创建工具输出题材身份、启用状态、复用标记和后续操作。
export const createGenreOutput = z.object({ id, name: z.string(), enabled: z.boolean(), reused: z.boolean(), next_actions: nextActions });
// 供海报暂存工具输出受限令牌、格式、大小、过期时间和后续操作。
export const stagePosterOutput = z.object({ staged_poster_token: token, format: z.enum(['jpeg','png','webp']), byte_size: z.number().int().nonnegative(), expires_at: z.iso.datetime({ offset: true }), next_actions: nextActions });
// 供剧集结构输出隐藏视频对象，仅公开视频是否存在。
const structureEpisode = apiEpisode.omit({ video: true }).extend({ has_video: z.boolean() });
// 供剧集结构工具输出剧集版本、状态、季及安全的单集字段。
export const getSeriesStructureOutput = z.object({ series_id: id, version, status, seasons: z.array(z.object({ id, number: positiveInt, episodes: z.array(structureEpisode) })), next_actions: nextActions });
// 供电影创建工具沿用内容标识、版本、状态及后续操作输出。
export const createMovieOutput = contentResult;
// 供剧集创建工具沿用内容标识、版本、状态及后续操作输出。
export const createSeriesOutput = contentResult;
// 供创建季工具输出剧集及季标识、父版本和后续操作。
export const createSeasonOutput = z.object({ series_id: id, series_version: version, season_id: id, next_actions: nextActions });
// 供单集创建、更新和发布工具输出内容结果及父剧集版本。
export const episodeOutput = contentResult.extend({ series_version: version });
