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
import { destructiveAnnotations, parseApi, toolResult } from '../schemas/common.js';
import { mapHttpError } from '../services/error-mapper.js';
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

// 表示写入前或按 UUID 回查得到的目标快照，只含经过验证的字段。
type VisibilitySnapshot = z.output<typeof apiContentVisibility>;
// 按维护动作保留访问范围或生命周期状态，用于比较写前与回查快照。
type MaintenanceSnapshot = LifecycleSnapshot | VisibilitySnapshot;

// 可直接交给协议调用方的固定错误消息、机器码和可核实的状态字段。
class MaintenanceFailure extends Error {
  // 根据本地操作阶段设置安全说明，原始远端正文和凭据不进入结果。
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

// 确认是否收到明确的客户端错误状态，响应正文超限时仍可按 HTTP 状态识别拒绝原因。
function definiteRejection(error: unknown): MovieHarborClientError | undefined {
  if (!(error instanceof MovieHarborClientError) || error.status === undefined
    || error.status < 400 || error.status >= 500) return undefined;
  return error.code === 'response_too_large' ? mapHttpError(error.status, null, '') : error;
}

// 回查只能报告相同或更新的已验证快照，过期副本和同版本下互相矛盾的值均不能作为现状。
function consistentReadback(previous: MaintenanceSnapshot, next: MaintenanceSnapshot): boolean {
  if (next.version < previous.version) return false;
  if ('is_private' in previous && 'is_private' in next) {
    return next.version > previous.version || next.is_private === previous.is_private;
  }
  if (!('status' in previous && 'status' in next)) return false;
  if (previous.series_version !== undefined && (next.series_version === undefined
    || next.series_version - previous.series_version < next.version - previous.version)) return false;
  return next.version > previous.version || next.status === previous.status;
}

// 组织两次可核实的业务数据；回查未取得对应快照时保留显式空值。
function snapshotEvidence(previous: MaintenanceSnapshot, latest: MaintenanceSnapshot | null) {
  if ('is_private' in previous) {
    const visibility = latest && 'is_private' in latest && (latest.is_private ? 'private' : 'public');
    return {
      last_confirmed_visibility: previous.is_private ? 'private' : 'public',
      current_visibility: visibility || null,
    };
  }
  const state = latest && 'status' in latest ? latest : null;
  return {
    last_confirmed_status: previous.status,
    current_status: state?.status ?? null,
    ...(previous.series_version === undefined ? {} : {
      last_confirmed_series_version: previous.series_version,
      current_series_version: state?.series_version ?? null,
    }),
  };
}

// 一次写入的回执不可靠时，只读原 UUID 一次；即使读到目标状态，也无法排除并发调用的贡献。
async function handleWriteFailure(
  error: unknown, input: MaintenanceInput, previous: MaintenanceSnapshot,
  readLatest: () => Promise<MaintenanceSnapshot>, partial = false,
): Promise<never> {
  const rejected = definiteRejection(error);
  if (rejected && !partial) throw rejected;
  let latest: MaintenanceSnapshot | null = null;
  if (!rejected) {
    const observed = await readLatest().catch(() => null);
    if (observed && consistentReadback(previous, observed)) latest = observed;
  }
  const code = partial ? 'partial_transition'
    : error instanceof MovieHarborClientError && error.code === 'invalid_response' ? 'invalid_response' : 'write_result_unknown';
  const details = {
    content_type: input.content_type, content_id: previous.id,
    ...(input.content_type === 'episode' ? { series_id: input.series_id, season_id: input.season_id } : {}),
    commit_status: rejected ? 'not_committed' : 'unknown',
    ...(rejected ? { cause_code: rejected.code } : {}),
    last_confirmed_version: previous.version, current_version: latest?.version ?? null,
    ...snapshotEvidence(previous, latest),
  };
  let message = '按 UUID 回查未取得可信的当前状态，写入结果待确认。';
  if (latest) message = '已按 UUID 回查当前内容，仍无法确认本次写入是否提交。';
  if (rejected) message = '转草稿请求已被拒绝。' + rejected.message;
  throw new MaintenanceFailure(code, (partial ? '已确认归档。' : '') + message, details);
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
  // 初次读取和回查都使用相同的 UUID 路径及身份校验。
  async function readVisibility(): Promise<VisibilitySnapshot> {
    const snapshot = parseApi(apiContentVisibility, await client.json('GET', path));
    if (snapshot.id !== parsed.content_id) throw new MovieHarborClientError('invalid_response');
    return snapshot;
  }
  const current = await readVisibility();
  assertCurrentVersion(current.version, parsed.version);
  const changed = current.is_private !== isPrivate;
  let result = current;
  if (changed) {
    try {
      result = parseApi(apiContentVisibility, await client.json('PUT', path + '/privacy', {
        version: current.version, is_private: isPrivate,
      }));
      if (result.id !== current.id || result.is_private !== isPrivate || result.version !== current.version + 1) {
        throw new MovieHarborClientError('invalid_response');
      }
    } catch (error) {
      return handleWriteFailure(error, parsed, current, readVisibility);
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
  if (current === 'draft' && target === 'archived') throw new MaintenanceFailure('invalid_transition', '草稿不能直接归档。');
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
  // 使用完整 UUID 层级读取单集；回查复用同一路径和归属校验，避免按名称另选目标。
  async function readLifecycle(): Promise<LifecycleSnapshot> {
    return readLifecycleResponse(parsed, await client.json('GET', path));
  }
  const initial = await readLifecycle();
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
        ...(current.series_version === undefined ? {} : { series_version: current.series_version }),
      }));
      if (result.status !== target || result.version !== current.version + 1
        || (current.series_version !== undefined && result.series_version !== current.series_version + 1)) {
        throw new MovieHarborClientError('invalid_response');
      }
      current = result;
      transitionedThrough.push(result.status);
    } catch (error) {
      if (target === 'published' && error instanceof MovieHarborClientError && error.code === 'validation_error') {
        // 只有发布请求失败时才解释其后端字段，其他操作继续使用通用错误。
        const reasons = Object.entries(publishValidationReasons)
          .filter(([field]) => error.fields.includes(field))
          .map(([, reason]) => reason);
        if (reasons.length > 0) throw new MaintenanceFailure(error.code, '发布条件未满足：' + reasons.join('，') + '。');
      }
      // 任一步回执不可确认时停在此处，附上一次只读回查；第一步存疑时不再转草稿。
      return handleWriteFailure(error, parsed, current, readLifecycle, transitionedThrough.length > 0);
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

// SDK 默认把抛出的异常压成文本，因此在工具边界保留固定错误码和恢复快照。
async function maintenanceResult(operation: Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return await operation;
  } catch (error) {
    if (!(error instanceof MaintenanceFailure || error instanceof MovieHarborClientError)) throw error;
    return {
      isError: true, content: [{ type: 'text', text: error.message }],
      structuredContent: { code: error.code, ...(error instanceof MaintenanceFailure ? error.details : {}) },
    };
  }
}

// 构建服务器时统一注册访问范围和生命周期工具，分别接收用户确认。
export function registerContentMaintenanceTools(server: McpServer, client: MovieHarborClient): void {
  server.registerTool('set_content_visibility', {
    description: '经用户明确确认后修改电影或整剧访问范围；传入目标的当前版本。',
    inputSchema: setContentVisibilityInput,
    outputSchema: setContentVisibilityOutput,
    annotations: destructiveAnnotations,
  }, input => maintenanceResult(setContentVisibility(input, client)));

  server.registerTool('transition_content_lifecycle', {
    description: '经用户明确确认后发布、归档或转草稿。发布需要单独确认；单集和父剧集分别操作。已发布内容转草稿时先归档，操作前须说明下线影响。',
    inputSchema: transitionContentLifecycleInput,
    outputSchema: transitionContentLifecycleOutput,
    annotations: destructiveAnnotations,
  }, input => maintenanceResult(transitionContentLifecycle(input, client)));
}
