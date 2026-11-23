import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import {
  apiContentLifecycle,
  apiContentVisibility,
  apiLifecycleEpisode,
  apiLifecycleParent,
  setContentVisibilityInput,
  setContentVisibilityOutput,
  transitionContentLifecycleInput,
  transitionContentLifecycleOutput,
} from '../schemas/admin-maintenance.js';
import { parseApi, toolResult, writeAnnotations } from '../schemas/common.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';

// 表示维护工具返回的已校验结构化结果和安全文本。
type ToolResult = ReturnType<typeof toolResult>;
// 表示通过严格校验的生命周期转换请求。
type LifecycleInput = z.output<typeof transitionContentLifecycleInput>;
// 保留经校验的维护操作目标，供写入结果待确认时引导调用者重新查询。
type MaintenanceInput = LifecycleInput | z.output<typeof setContentVisibilityInput>;
// 表示已读取并核对归属的生命周期状态，单集附带父剧集版本。
type LifecycleSnapshot = z.output<typeof apiContentLifecycle> & { series_version?: number };
// 表示受控生命周期状态，供路径规划和逐步校验使用。
type LifecycleStatus = LifecycleSnapshot['status'];

// 归档已确认而转草稿结果待确认时抛出稳定错误。
class PartialTransitionError extends Error {
  readonly code = 'partial_transition';
  readonly lastConfirmedStatus = 'archived';

  // 生成不含下游错误细节的部分完成说明，引导调用方重新读取。
  constructor() {
    super('生命周期转换部分完成：已确认归档，转草稿结果未确认，请重新读取内容状态。');
    this.name = 'PartialTransitionError';
  }
}

// 写入遇到传输中断时表示远端可能已经提交，需要读取实际状态。
class WriteResultUnknownError extends Error {
  readonly code = 'write_result_unknown';

  // 根据写入动作提示调用者重新查询需要核对的字段。
  constructor(field: '访问范围' | '当前状态') {
    super('写入结果待确认，请重新查询目标内容并核对' + field + '和版本。');
    this.name = 'WriteResultUnknownError';
  }
}

// 只在写请求无法取得服务端结果时提供重新查询指引，保留已知的后端拒绝语义。
function rethrowWriteError(error: unknown, field: '访问范围' | '当前状态'): never {
  if (error instanceof MovieHarborClientError && (error.code === 'network_error' || error.code === 'timeout')) {
    throw new WriteResultUnknownError(field);
  }
  throw error;
}

// 根据通过 schema 校验的顶层类型和 UUID 生成受控详情路径。
function contentPath(contentType: 'movie' | 'series', contentId: string): string {
  return '/api/admin/' + (contentType === 'movie' ? 'movies/' : 'series/') + contentId;
}

// 读取内容后确认用户使用的是当前版本，陈旧请求不能进入写入流程。
function assertCurrentVersion(current: number, expected: number): void {
  if (current !== expected) throw new MovieHarborClientError('version_conflict', 409);
}

// 用户明确确认后设置电影或整剧访问范围，并返回核验后的新版本。
export async function setContentVisibility(input: unknown, client: MovieHarborClient): Promise<ToolResult> {
  const parsed = setContentVisibilityInput.parse(input);
  const path = contentPath(parsed.content_type, parsed.content_id);
  const isPrivate = parsed.visibility === 'private';

  // 隐私接口即使重复传相同范围也会增长版本，因此先读取并在同范围时直接返回。
  const current = parseApi(apiContentVisibility, await client.json('GET', path));
  if (current.id !== parsed.content_id) throw new MovieHarborClientError('invalid_response');
  assertCurrentVersion(current.version, parsed.version);
  const changed = current.is_private !== isPrivate;
  let result = current;
  if (changed) {
    // 使用已确认的版本写入，使后端可以拒绝读取与写入之间的并发修改。
    result = parseApi(apiContentVisibility, await client.json('PUT', path + '/privacy', {
      version: current.version,
      is_private: isPrivate,
    }).catch(error => rethrowWriteError(error, '访问范围')));
    if (result.id !== current.id || result.is_private !== isPrivate || result.version !== current.version + 1) {
      throw new MovieHarborClientError('invalid_response');
    }
  }

  const scope = isPrivate ? '私密' : '公开';
  return toolResult(setContentVisibilityOutput, {
    content_type: parsed.content_type,
    content_id: result.id,
    visibility: parsed.visibility,
    version: result.version,
    next_actions: [parsed.content_type === 'movie' ? 'search_movies' : 'get_series_structure'],
  }, changed ? '访问范围已改为' + scope + '。' : '访问范围已是' + scope + '，无需重复更新。');
}

// 解析读写响应时核对目标标识，单集另外校验季归属和响应中可选的父剧标识。
function readLifecycleResponse(input: LifecycleInput, response: unknown): LifecycleSnapshot {
  if (input.content_type === 'episode') {
    const { episode, series_id, series_version } = parseApi(apiLifecycleEpisode, response);
    // 单集封装现有必填 season_id，若响应包含 series_id，也必须与完整路由一致。
    if (episode.id !== input.content_id || episode.season_id !== input.season_id
      || (series_id !== undefined && series_id !== input.series_id)
      || (episode.series_id !== undefined && episode.series_id !== input.series_id)) {
      throw new MovieHarborClientError('invalid_response');
    }
    return { id: episode.id, version: episode.version, status: episode.status, series_version };
  }

  const content = parseApi(apiContentLifecycle, response);
  if (content.id !== input.content_id) throw new MovieHarborClientError('invalid_response');
  return content;
}

// 在写入前规划现有状态机允许的目标顺序。
function transitionSteps(current: LifecycleStatus, target: LifecycleStatus): LifecycleStatus[] {
  if (current === target) return [];
  if (current === 'draft' && target === 'archived') throw new Error('草稿不能直接归档。');
  if (current === 'published' && target === 'draft') return ['archived', 'draft'];
  return [target];
}

// 将通过状态机校验的目标状态映射到现有写入路由。
const lifecycleActions = { draft: 'draft', published: 'publish', archived: 'archive' } as const;
// 用于工具结果摘要的生命周期状态名称。
const lifecycleLabels = { draft: '草稿', published: '已发布', archived: '已归档' } as const;

// 发布接口的字段码对应固定中文原因，未知字段不进入协议输出。
const publishValidationReasons = {
  name: '缺少名称',
  video: '缺少可访问且受支持的视频',
  episodes: '至少需要一集已发布的单集，且该集的视频可访问、格式受支持',
};

// 读取并验证已确认内容后执行合法状态转换，逐步返回可核对的结果。
export async function transitionContentLifecycle(input: unknown, client: MovieHarborClient): Promise<ToolResult> {
  const parsed = transitionContentLifecycleInput.parse(input);
  const path = parsed.content_type === 'episode'
    ? contentPath('series', parsed.series_id) + '/seasons/' + parsed.season_id + '/episodes/' + parsed.content_id
    : contentPath(parsed.content_type, parsed.content_id);

  // 单集先读取父剧集以核对其身份和版本，父剧生命周期仍由独立调用管理。
  const parent = parsed.content_type === 'episode'
    ? parseApi(apiLifecycleParent, await client.json('GET', contentPath('series', parsed.series_id)))
    : undefined;
  if (parsed.content_type === 'episode' && parent?.id !== parsed.series_id) {
    throw new MovieHarborClientError('invalid_response');
  }
  const initial = readLifecycleResponse(parsed, await client.json('GET', path));
  if (parsed.content_type === 'episode' && (!parent || initial.series_version !== parent.version
    || !parent.seasons.some(season => season.id === parsed.season_id
      && season.episodes.some(episode => episode.id === parsed.content_id)))) {
    throw new MovieHarborClientError('invalid_response');
  }
  assertCurrentVersion(initial.version, parsed.version);

  // 两次写入间传递实际响应中的版本；第二步失败时，保留已确认的归档事实。
  const transitionedThrough: LifecycleStatus[] = [];
  let current = initial;
  for (const target of transitionSteps(initial.status, parsed.target_status)) {
    try {
      const result = readLifecycleResponse(parsed, await client.json('POST', path + '/' + lifecycleActions[target], {
        version: current.version,
      }));
      if (result.status !== target || result.version !== current.version + 1
        || (current.series_version !== undefined && result.series_version !== current.series_version + 1)) {
        throw new MovieHarborClientError('invalid_response');
      }
      current = result;
      transitionedThrough.push(result.status);
    } catch (error) {
      if (transitionedThrough.length > 0) throw new PartialTransitionError();
      if (target === 'published' && error instanceof MovieHarborClientError && error.code === 'validation_error') {
        // 只有发布请求失败时才解释其后端字段，其他操作继续使用通用错误。
        const reasons = Object.entries(publishValidationReasons)
          .filter(([field]) => error.fields.includes(field))
          .map(([, reason]) => reason);
        if (reasons.length > 0) throw new Error('发布条件未满足：' + reasons.join('，') + '。');
      }
      // 首步或单步写入响应丢失时暂停，由调用者读取目标；不启动后续状态写入。
      rethrowWriteError(error, '当前状态');
    }
  }

  const suggestParentPublish = current.status === 'published' && parent?.status === 'draft';
  const summary = transitionedThrough.length === 0
    ? '内容状态已为' + lifecycleLabels[current.status] + '，无需重复转换。'
    : '内容状态已转换为' + lifecycleLabels[current.status] + '。';
  return toolResult(transitionContentLifecycleOutput, {
    content_type: parsed.content_type,
    content_id: current.id,
    previous_status: initial.status,
    transitioned_through: transitionedThrough,
    status: current.status,
    version: current.version,
    ...(parsed.content_type === 'episode' ? { series_version: current.series_version } : {}),
    next_actions: suggestParentPublish ? ['transition_content_lifecycle'] : [],
  }, summary + (suggestParentPublish ? '父剧集仍需单独确认发布。' : ''));
}

// SDK 会把异常压成文本，显式返回可恢复写入错误的状态和目标，供 MCP 客户端处理。
async function maintenanceResult(input: MaintenanceInput, operation: Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof PartialTransitionError) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: { code: error.code, last_confirmed_status: error.lastConfirmedStatus },
      };
    }
    if (!(error instanceof WriteResultUnknownError)) throw error;
    const nextAction = input.content_type === 'movie' ? 'search_movies'
      : input.content_type === 'series' ? 'search_series' : 'get_series_structure';
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: {
        code: error.code,
        content_type: input.content_type,
        content_id: input.content_id,
        ...(input.content_type === 'episode' ? { series_id: input.series_id, season_id: input.season_id } : {}),
        next_actions: [nextAction],
      },
    };
  }
}

// 构建服务器时统一注册访问范围和生命周期工具，分别接收用户确认。
export function registerContentMaintenanceTools(server: McpServer, client: MovieHarborClient): void {
  server.registerTool('set_content_visibility', {
    description: '经用户明确确认后修改电影或整剧访问范围；传入目标的当前版本。',
    inputSchema: setContentVisibilityInput,
    outputSchema: setContentVisibilityOutput,
    annotations: writeAnnotations,
  }, input => maintenanceResult(input, setContentVisibility(input, client)));

  server.registerTool('transition_content_lifecycle', {
    description: '经用户明确确认后发布、归档或转草稿。发布需要单独确认；单集和父剧集分别操作。已发布内容转草稿时先归档，操作前须说明下线影响。',
    inputSchema: transitionContentLifecycleInput,
    outputSchema: transitionContentLifecycleOutput,
    annotations: writeAnnotations,
  }, input => maintenanceResult(input, transitionContentLifecycle(input, client)));
}
