import type { McpServer } from '@modelcontextprotocol/server';
import { contentResult, parseApi, toolResult, writeAnnotations } from '../schemas/common.js';
import { apiMovieWithSynopsis, apiSeriesWithSynopsis, updateContentSynopsisInput } from '../schemas/content.js';
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
  return contentType === 'movie'
    ? parseApi(apiMovieWithSynopsis, value)
    : parseApi(apiSeriesWithSynopsis, value);
}

// 校验每次生命周期响应的身份、状态和严格递增版本，异常时停止后续写入。
function assertTransition(
  content: ReturnType<typeof parseContent>,
  contentId: string,
  status: 'draft' | 'archived',
  version: number,
  synopsis?: string,
) {
  if (content.id !== contentId || content.status !== status || content.version !== version
    || (synopsis !== undefined && content.synopsis !== synopsis)) {
    throw new MovieHarborClientError('invalid_response');
  }
}

// 仅网络中断、超时或无法可信解析响应时结果不明；明确 HTTP 错误必须原样停止。
function shouldReconcile(error: unknown) {
  return error instanceof MovieHarborClientError
    && ['network_error', 'timeout', 'invalid_response', 'response_too_large'].includes(error.code);
}

// 执行一个生命周期或简介写入；响应不明时读回状态，精确匹配已提交结果才继续。
async function writeAndReconcile(
  client: MovieHarborClient,
  contentType: ContentType,
  contentId: string,
  contentPath: string,
  method: 'POST' | 'PATCH',
  actionPath: string,
  body: { version: number; synopsis?: string },
  expectedStatus: 'draft' | 'archived',
  expectedVersion: number,
  expectedSynopsis?: string,
) {
  try {
    const written = parseContent(contentType, await client.json(method, actionPath, body));
    assertTransition(written, contentId, expectedStatus, expectedVersion, expectedSynopsis);
    return written;
  } catch (writeError) {
    if (!shouldReconcile(writeError)) throw writeError;
    let latest: ReturnType<typeof parseContent>;
    try {
      // 写请求可能已提交但响应丢失；读回精确状态、版本和简介后才能安全继续。
      latest = parseContent(contentType, await client.json('GET', contentPath));
      if (latest.id !== contentId) throw new MovieHarborClientError('invalid_response');
    } catch {
      throw new Error(`简介修改未完成，且无法确认当前状态；最后确认版本为 ${body.version}，请重新读取内容后重试。`);
    }
    if (latest.status === expectedStatus && latest.version === expectedVersion
      && (expectedSynopsis === undefined || latest.synopsis === expectedSynopsis)) {
      return latest;
    }
    // 状态和版本均来自受控 API schema，可安全提示调用者从明确检查点恢复。
    throw new Error(`简介修改未完成；内容当前状态为 ${latest.status}，版本为 ${latest.version}，请使用该版本重新调用。`);
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
    current = await writeAndReconcile(
      client, parsed.content_type, parsed.content_id, path, 'POST', `${path}/archive`,
      { version: current.version }, 'archived', parsed.version + 1,
    );
  }

  if (current.status === 'archived') {
    // 归档内容转回草稿后才能复用现有元数据更新接口。
    const expectedVersion = current.version + 1;
    current = await writeAndReconcile(
      client, parsed.content_type, parsed.content_id, path, 'POST', `${path}/draft`,
      { version: current.version }, 'draft', expectedVersion,
    );
  }

  // 只提交版本和简介；后端沿用草稿编辑校验并递增版本。
  const expectedVersion = current.version + 1;
  const updated = await writeAndReconcile(
    client, parsed.content_type, parsed.content_id, path, 'PATCH', path,
    { version: current.version, synopsis: parsed.synopsis }, 'draft', expectedVersion, parsed.synopsis,
  );

  const hasVideo = parsed.content_type === 'movie' && 'video' in updated && updated.video !== null;
  const nextActions = parsed.content_type === 'movie'
    ? (hasVideo ? ['transition_content_lifecycle'] : ['upload_movie_video'])
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
    // 已发布内容会被下线并保留为草稿，必须向 MCP 客户端声明破坏性副作用。
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, input => updateContentSynopsis(input, client));
}
