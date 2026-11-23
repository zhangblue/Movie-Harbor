import type { McpServer } from '@modelcontextprotocol/server';
import {
  getSystemOverviewInput, getSystemOverviewOutput, listMissingVideosInput, listMissingVideosOutput,
} from '../schemas/admin-maintenance.js';
import { parseApi, readOnlyAnnotations, toolResult } from '../schemas/common.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';

// 表示包含文本摘要与已校验结构数据的只读工具结果。
type ToolResult = ReturnType<typeof toolResult>;

// 按明确选择的内容类型读取一页缺视频槽位，供 MCP 查询现有电影或具体单集。
export async function listMissingVideos(input: unknown, client: MovieHarborClient): Promise<ToolResult> {
  const { content_type, page } = listMissingVideosInput.parse(input);
  const query = new URLSearchParams({ content_type });
  if (page !== undefined) query.set('page', String(page));

  // 直接请求后端快照页，含额外字段或与本次请求不符的结果统一按无效响应处理。
  const result = parseApi(
    listMissingVideosOutput,
    await client.json('GET', `/api/admin/contents/missing-videos?${query}`),
  );
  const expectedItems = Math.max(0, Math.min(result.size, result.total - (result.page - 1) * result.size));
  if (result.content_type !== content_type || result.page !== (page ?? 1) || result.items.length !== expectedItems) {
    throw new MovieHarborClientError('invalid_response');
  }

  const kind = content_type === 'movie' ? '电影' : '单集';
  return toolResult(
    listMissingVideosOutput,
    result,
    `缺视频的${kind}共 ${result.total} 条，第 ${result.page} 页返回 ${result.items.length} 条。`,
  );
}

// 读取一次既有系统概览，供 MCP 查看后端采样的状态、计数、容量和告警。
export async function getSystemOverview(input: unknown, client: MovieHarborClient): Promise<ToolResult> {
  getSystemOverviewInput.parse(input === undefined ? {} : input);
  // 请求成功后校验原样返回的数据，异常结构统一映射为安全的无效响应。
  const response = await client.json('GET', '/api/admin/system/overview');
  return toolResult(getSystemOverviewOutput, response, '已读取系统概览。');
}

// 在 MCP 服务器启动时注册管理端只读查询工具。
export function registerAdminQueryTools(server: McpServer, client: MovieHarborClient): void {
  server.registerTool('list_missing_videos', {
    description: '查询缺视频的电影或剧集下的已有单集。传入 movie 或 series，每页 20 条；省略 page 时读取第 1 页。',
    inputSchema: listMissingVideosInput,
    outputSchema: listMissingVideosOutput,
    annotations: readOnlyAnnotations,
  }, input => listMissingVideos(input, client));
  // 概览工具只读取管理页面的同一份快照，并向调用者公开完整结果契约。
  server.registerTool('get_system_overview', {
    description: '只读获取系统概览，包括应用版本、内容和用户计数、媒体卷容量、备份状态与告警。无需参数。',
    inputSchema: getSystemOverviewInput,
    outputSchema: getSystemOverviewOutput,
    annotations: readOnlyAnnotations,
  }, input => getSystemOverview(input, client));
}
