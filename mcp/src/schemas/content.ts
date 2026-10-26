import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { id, name, year, duration, durationMinutes, synopsis, visibility, confirmed, version, positiveInt, status, nextActions, contentResult } from './common.js';

const genreIds = z.array(id).min(1).refine(ids => new Set(ids).size === ids.length, '题材 ID 不可重复');
const token = z.string().trim().min(1);
const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
export const searchMoviesInput = z.strictObject({ name });
export const searchSeriesInput = z.strictObject({ name });
export const getSeriesStructureInput = z.strictObject({ series_id: id });
export const listGenresInput = z.strictObject({});
export const createGenreInput = z.strictObject({ name });
export const stagePosterInput = z.strictObject({ path: localPath });
const createFields = { name, year, genre_ids: genreIds, staged_poster_token: token };
export const createMovieInput = z.strictObject({ ...createFields, synopsis, duration_minutes: durationMinutes, visibility, confirmed });
export const createSeriesInput = z.strictObject(createFields);
export const createSeasonInput = z.strictObject({ series_id: id, version, number: positiveInt.max(2_147_483_647) });
export const createEpisodeInput = z.strictObject({ series_id: id, season_id: id, version, number: positiveInt.max(2_147_483_647), name, duration_seconds: duration });
const metadata = { name: name.optional(), synopsis: z.string().optional(), year: year.optional(), genre_ids: genreIds.optional() };
export const updateMovieInput = z.strictObject({ movie_id: id, version, ...metadata, duration_minutes: durationMinutes.optional() })
  .refine(value => [value.name, value.synopsis, value.year, value.genre_ids, value.duration_minutes].some(v => v !== undefined), '至少提供一个修改字段');
export const updateSeriesInput = z.strictObject({ series_id: id, version, ...metadata })
  .refine(value => [value.name, value.synopsis, value.year, value.genre_ids].some(v => v !== undefined), '至少提供一个修改字段');
export const updateEpisodeInput = z.strictObject({ series_id: id, season_id: id, episode_id: id, version, number: positiveInt.max(2_147_483_647).optional(), name: name.optional(), duration_seconds: duration.optional() })
  .refine(value => [value.number, value.name, value.duration_seconds].some(v => v !== undefined), '至少提供一个修改字段');

// Only declared fields survive API parsing; media paths and arbitrary response fields never escape.
const media = z.object({ id }).nullable();
const base = { id, name: z.string(), year: year.nullable(), status, version, is_private: z.boolean(), poster: media };
export const apiMovie = z.object({ ...base, duration_seconds: duration.nullable(), video: media });
export const apiEpisode = z.object({ id, number: positiveInt, name: z.string(), duration_seconds: duration.nullable(), status, version, video: media });
export const apiSeason = z.object({ id, number: positiveInt, episodes: z.array(apiEpisode) });
export const apiSeries = z.object({ ...base, seasons: z.array(apiSeason) });
export const apiGenre = z.object({ id, name: z.string(), enabled: z.boolean() });
export const apiEpisodeEnvelope = z.object({ series_version: version, series_id: id.optional(), episode: apiEpisode.extend({ season_id: id, series_id: id.optional() }) });
export const apiStagedPoster = z.object({ token, format: z.enum(['jpeg','png','webp']), byte_size: z.number().int().nonnegative(), expires_at: z.iso.datetime({ offset: true }) });

const movieMatch = z.object({ id, name: z.string(), year: year.nullable(), duration_minutes: durationMinutes.nullable(), status, version, is_private: z.boolean(), has_poster: z.boolean(), has_video: z.boolean(), exact: z.boolean() });
const seriesMatch = z.object({ id, name: z.string(), year: year.nullable(), status, version, is_private: z.boolean(), has_poster: z.boolean(), season_count: z.number().int().nonnegative(), episode_count: z.number().int().nonnegative(), exact: z.boolean() });
const searchFields = { query: z.string(), normalized_name: z.string(), exact_match_count: z.number().int().nonnegative(), requires_selection: z.boolean(), next_actions: nextActions };
export const searchMoviesOutput = z.object({ ...searchFields, matches: z.array(movieMatch) });
export const searchSeriesOutput = z.object({ ...searchFields, matches: z.array(seriesMatch) });
export const listGenresOutput = z.object({ genres: z.array(apiGenre), next_actions: nextActions });
export const createGenreOutput = z.object({ id, name: z.string(), enabled: z.boolean(), reused: z.boolean(), next_actions: nextActions });
export const stagePosterOutput = z.object({ staged_poster_token: token, format: z.enum(['jpeg','png','webp']), byte_size: z.number().int().nonnegative(), expires_at: z.iso.datetime({ offset: true }), next_actions: nextActions });
const structureEpisode = apiEpisode.omit({ video: true }).extend({ has_video: z.boolean() });
export const getSeriesStructureOutput = z.object({ series_id: id, version, status, seasons: z.array(z.object({ id, number: positiveInt, episodes: z.array(structureEpisode) })), next_actions: nextActions });
export const createMovieOutput = contentResult;
export const createSeriesOutput = contentResult;
export const createSeasonOutput = z.object({ series_id: id, series_version: version, season_id: id, next_actions: nextActions });
export const episodeOutput = contentResult.extend({ series_version: version });
