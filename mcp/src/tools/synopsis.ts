import type { McpServer } from '@modelcontextprotocol/server';
import { contentResult, parseApi, toolResult, writeAnnotations } from '../schemas/common.js';
import { apiMovie, apiSeries, updateContentSynopsisInput } from '../schemas/content.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';

type ContentType = 'movie' | 'series';

// 根据内容类型返回现有管理接口路径，电影和剧集仍由同一个简介函数调度。
function contentPath(contentType: ContentType, contentId: string) {
  return contentType === 'movie'
    ? `/api/admin/movies/${contentId}`
    : `/api/admin/series/${contentId}`;
}

// 按内容类型校验后端响应，只保留 MCP 后续流程需要的安全字段。
function parseContent(contentType: ContentType, value: unknown) {
  return contentType === 'movie' ? parseApi(apiMovie, value) : parseApi(apiSeries, value);
}

// 校验每次生命周期响应的身份、状态和严格递增版本，异常时停止后续写入。
function assertTransition(
  content: ReturnType<typeof parseContent>,
  contentId: string,
  status: 'draft' | 'archived',
  version: number,
) {
  if (content.id !== contentId || content.status !== status || content.version !== version) {
    throw new MovieHarborClientError('invalid_response');
  }
}

// 使用现有电影或剧集接口自动回到草稿并只修改简介，完成后不重新发布。
export async function updateContentSynopsis(input: unknown, client: MovieHarborClient) {
  const parsed = updateContentSynopsisInput.parse(input);
  const path = contentPath(parsed.content_type, parsed.content_id);

  // 先读取当前状态和版本，防止使用过期版本执行归档或草稿转换。
  let current = parseContent(parsed.content_type, await client.json('GET', path));
  if (current.id !== parsed.content_id) throw new MovieHarborClientError('invalid_response');
  if (current.version !== parsed.version) throw new MovieHarborClientError('version_conflict', 409);

  if (current.status === 'published') {
    // 已发布内容必须先归档；使用返回版本继续转草稿，避免跨步骤覆盖并发写入。
    current = parseContent(parsed.content_type, await client.json('POST', `${path}/archive`, {
      version: current.version,
    }));
    assertTransition(current, parsed.content_id, 'archived', parsed.version + 1);
  }

  if (current.status === 'archived') {
    // 归档内容转回草稿后才能复用现有元数据更新接口。
    const expectedVersion = current.version + 1;
    current = parseContent(parsed.content_type, await client.json('POST', `${path}/draft`, {
      version: current.version,
    }));
    assertTransition(current, parsed.content_id, 'draft', expectedVersion);
  }

  // 只提交版本和简介；后端沿用草稿编辑校验并递增版本。
  const expectedVersion = current.version + 1;
  const updated = parseContent(parsed.content_type, await client.json('PATCH', path, {
    version: current.version,
    synopsis: parsed.synopsis,
  }));
  assertTransition(updated, parsed.content_id, 'draft', expectedVersion);

  const hasVideo = parsed.content_type === 'movie' && 'video' in updated && updated.video !== null;
  const nextActions = parsed.content_type === 'movie'
    ? (hasVideo ? ['publish_movie'] : ['upload_movie_video'])
    : ['get_series_structure'];
  return toolResult(contentResult, {
    id: updated.id,
    version: updated.version,
    status: updated.status,
    next_actions: nextActions,
  }, '已修改简介，内容保持草稿状态。');
}

// 构建服务器时只注册一个电影和剧集共用的简介修改工具。
export function registerSynopsisTools(server: McpServer, client: MovieHarborClient) {
  // 注册 update_content_synopsis：必要时自动归档并转草稿，只修改简介且不重新发布。
  server.registerTool('update_content_synopsis', {
    description: '修改电影或剧集简介；已发布内容自动归档并转草稿，已归档内容自动转草稿，完成后保持草稿状态。',
    inputSchema: updateContentSynopsisInput,
    outputSchema: contentResult,
    annotations: writeAnnotations,
  }, input => updateContentSynopsis(input, client));
}
