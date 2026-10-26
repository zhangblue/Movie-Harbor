import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MovieHarborClient } from '../services/movie-harbor-client.js';
import { MovieHarborClientError } from '../services/error-mapper.js';
import { normalizedName, parseApi, readOnlyAnnotations, toolResult } from '../schemas/common.js';
import { searchMoviesInput, searchSeriesInput, getSeriesStructureInput, searchMoviesOutput, searchSeriesOutput, getSeriesStructureOutput, apiMovie, apiSeries } from '../schemas/content.js';

export async function searchMovies(input: unknown, client: MovieHarborClient) {
  const { name } = searchMoviesInput.parse(input);
  const candidates = parseApi(z.array(apiMovie), await client.json('GET', '/api/admin/movies'));
  const normalized_name = normalizedName(name);
  const matches = candidates.filter(movie => normalizedName(movie.name).includes(normalized_name)).map(movie => ({ id: movie.id, name: movie.name, year: movie.year, duration_seconds: movie.duration_seconds,
    status: movie.status, version: movie.version, is_private: movie.is_private, has_poster: movie.poster !== null, has_video: movie.video !== null, exact: normalizedName(movie.name) === normalized_name }));
  const exact_match_count = matches.filter(match => match.exact).length;
  return toolResult(searchMoviesOutput, { query: name, normalized_name, matches, exact_match_count, requires_selection: exact_match_count > 1,
    next_actions: matches.length ? ['update_movie_metadata'] : ['create_movie'] }, matches.length ? `找到 ${matches.length} 个电影候选，请明确选择后再操作。` : '未找到电影候选，可显式创建电影草稿。');
}
export async function searchSeries(input: unknown, client: MovieHarborClient) {
  const { name } = searchSeriesInput.parse(input);
  const candidates = parseApi(z.array(apiSeries), await client.json('GET', '/api/admin/series'));
  const normalized_name = normalizedName(name);
  const matches = candidates.filter(series => normalizedName(series.name).includes(normalized_name)).map(series => ({ id: series.id, name: series.name, year: series.year, status: series.status, version: series.version,
    is_private: series.is_private, has_poster: series.poster !== null, season_count: series.seasons.length,
    episode_count: series.seasons.reduce((count, season) => count + season.episodes.length, 0), exact: normalizedName(series.name) === normalized_name }));
  const exact_match_count = matches.filter(match => match.exact).length;
  return toolResult(searchSeriesOutput, { query: name, normalized_name, matches, exact_match_count, requires_selection: exact_match_count > 1,
    next_actions: matches.length ? ['get_series_structure', 'update_series_metadata'] : ['create_series'] }, matches.length ? `找到 ${matches.length} 个剧集候选，请明确选择后再操作。` : '未找到剧集候选，可显式创建剧集草稿。');
}
export async function getSeriesStructure(input: unknown, client: MovieHarborClient) {
  const { series_id } = getSeriesStructureInput.parse(input);
  const series = parseApi(apiSeries, await client.json('GET', `/api/admin/series/${series_id}`));
  if (series.id !== series_id) throw new MovieHarborClientError('invalid_response');
  return toolResult(getSeriesStructureOutput, { series_id: series.id, version: series.version, status: series.status,
    seasons: series.seasons.map(season => ({ id: season.id, number: season.number, episodes: season.episodes.map(({ video, ...episode }) => ({ ...episode, has_video: video !== null })) })),
    next_actions: series.seasons.length ? ['create_episode'] : ['create_season'] }, `已读取剧集结构，共 ${series.seasons.length} 季。`);
}
export function registerCatalogTools(server: McpServer, client: MovieHarborClient) {
  server.registerTool('search_movies', { description: '按名称查询电影候选；仅 trim 与大小写用于精确标记，不自动选择或合并。', inputSchema: searchMoviesInput, outputSchema: searchMoviesOutput, annotations: readOnlyAnnotations }, input => searchMovies(input, client));
  server.registerTool('search_series', { description: '按名称查询剧集候选；仅 trim 与大小写用于精确标记，不自动选择或合并。', inputSchema: searchSeriesInput, outputSchema: searchSeriesOutput, annotations: readOnlyAnnotations }, input => searchSeries(input, client));
  server.registerTool('get_series_structure', { description: '只读获取一个明确剧集的季、单集和版本。', inputSchema: getSeriesStructureInput, outputSchema: getSeriesStructureOutput, annotations: readOnlyAnnotations }, input => getSeriesStructure(input, client));
}
