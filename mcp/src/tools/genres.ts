import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MovieHarborClient } from '../services/movie-harbor-client.js';
import { MovieHarborClientError } from '../services/error-mapper.js';
import { normalizedName, parseApi, readOnlyAnnotations, writeAnnotations, toolResult } from '../schemas/common.js';
import { listGenresInput, createGenreInput, listGenresOutput, createGenreOutput, apiGenre } from '../schemas/content.js';

// 题材工具调用前读取并校验管理 API 题材。
async function readGenres(client: MovieHarborClient) { return parseApi(z.array(apiGenre), await client.json('GET', '/api/admin/genres')); }
// 创建题材前按规范化名称查找精确匹配。
function sameGenre(genres: z.output<typeof apiGenre>[], name: string) {
  const exact = genres.filter(genre => normalizedName(genre.name) === normalizedName(name));
  if (exact.some(genre => !genre.enabled)) throw new Error('同名题材已停用');
  if (exact.length > 1) throw new MovieHarborClientError('invalid_response');
  return exact[0];
}
// 执行题材列表工具时返回已校验题材。
export async function listGenres(input: unknown, client: MovieHarborClient) {
  listGenresInput.parse(input);
  const genres = await readGenres(client);
  return toolResult(listGenresOutput, { genres, next_actions: [] }, `已读取 ${genres.length} 个题材。`);
}
// 用户确认入库后复用或创建精确匹配题材。
export async function createGenre(input: unknown, client: MovieHarborClient) {
  const { name, confirmed: _confirmed } = createGenreInput.parse(input);
  const existing = sameGenre(await readGenres(client), name);
  if (existing) return toolResult(createGenreOutput, { ...existing, reused: true, next_actions: [] }, '已复用同名启用题材。');
  try {
    const created = parseApi(apiGenre, await client.json('POST', '/api/admin/genres', { name }));
    if (!created.enabled || normalizedName(created.name) !== normalizedName(name)) throw new MovieHarborClientError('invalid_response');
    return toolResult(createGenreOutput, { ...created, reused: false, next_actions: [] }, '已创建题材。');
  } catch (error) {
    if (!(error instanceof MovieHarborClientError) || error.status !== 409) throw error;
    const concurrent = sameGenre(await readGenres(client), name);
    if (!concurrent) throw error;
    return toolResult(createGenreOutput, { ...concurrent, reused: true, next_actions: [] }, '已复用并发创建的同名启用题材。');
  }
}
// 构建服务器时注册题材查询与创建工具。
export function registerGenreTools(server: McpServer, client: MovieHarborClient) {
  // 注册 list_genres：只读列出全部启用及停用题材。
  server.registerTool('list_genres', { description: '只读列出全部启用及停用题材。', inputSchema: listGenresInput, outputSchema: listGenresOutput, annotations: readOnlyAnnotations }, input => listGenres(input, client));
  // 注册 create_genre：携带入库确认 confirmed: true 后创建题材，复用精确同名启用项；停用同名项须人工处理。
  server.registerTool('create_genre', { description: '携带入库确认 confirmed: true 后创建题材，复用精确同名启用项；停用同名项须人工处理。', inputSchema: createGenreInput, outputSchema: createGenreOutput, annotations: { ...writeAnnotations, idempotentHint: true } }, input => createGenre(input, client));
}
