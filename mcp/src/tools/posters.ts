import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import {
  apiContentPosterDetail,
  apiContentPosterUpload,
  setContentPosterInput,
  setContentPosterOutput,
} from '../schemas/admin-maintenance.js';
import { parseApi, toolResult, writeAnnotations } from '../schemas/common.js';
import { serializeIdentity, validatePoster } from '../services/media-inspector.js';
import { MovieHarborClientError, type MovieHarborClient } from '../services/movie-harbor-client.js';
import { inspectAllowedFile } from '../services/path-policy.js';
import { UploadFileChangedAfterSendError } from '../services/upload-stream.js';

// 描述海报工具的管理 API 客户端和允许读取用户海报的目录。
export interface PosterToolDependencies {
  client: MovieHarborClient;
  allowedRoots: string[];
}

// 描述海报工具返回的已校验结构化结果和中文摘要。
type ToolResult = ReturnType<typeof toolResult>;
// 描述上传前和回查时从管理 API 读取的海报槽位。
type PosterSnapshot = z.output<typeof apiContentPosterDetail>;
// 描述写入可能已提交时提供给调用方的机器码和实际槽位快照。
type PosterWriteOutcome = {
  code: 'invalid_response' | 'media_replace_finalization_failed' | 'write_result_unknown';
  content_type: 'movie' | 'series';
  content_id: string;
  previous_poster_id: string | null;
  current_poster_id: string | null;
  previous_version: number;
  current_version: number | null;
  commit_status: 'committed' | 'unknown';
};

// 上传可能已提交时附上按 UUID 回查的结果，原始传输或文件系统错误留在客户端边界内。
class PosterWriteOutcomeError extends Error {
  readonly code: PosterWriteOutcome['code'];

  // 根据只读快照说明已确认提交、仍不确定或暂时无法读取目标。
  constructor(readonly outcome: PosterWriteOutcome) {
    const message = outcome.commit_status === 'committed'
      ? '海报写入已提交，服务端报告收尾失败。已按 UUID 核对当前槽位和版本。'
      : outcome.current_version === null
        ? '按 UUID 回查未取得当前海报槽位和版本，无法确认本次写入是否提交。'
        : '已按 UUID 读取当前海报槽位和版本，无法确认本次写入是否提交。';
    super(message);
    this.name = 'PosterWriteOutcomeError';
    this.code = outcome.code;
  }
}

// 本地预检时核对内容和文件身份，避免把预检后替换的文件交给上传客户端。
async function checkedPoster(path: string, roots: string[]) {
  try {
    const poster = await validatePoster(path, roots);
    const file = await inspectAllowedFile(path, roots);
    const identity = serializeIdentity(file);
    for (const field of ['dev', 'ino', 'size', 'mtime_ms'] as const) {
      if (identity[field] !== poster.identity[field]) throw new MovieHarborClientError('file_changed');
    }
    return { poster, file };
  } catch (error) {
    // 文件系统异常可能包含本机路径，以稳定错误替换原始诊断。
    if (error instanceof Error && 'syscall' in error) throw new MovieHarborClientError('file_changed');
    throw error;
  }
}

// 上传前和结果待确认时通过同一详情接口核对目标 UUID。
async function readPosterSnapshot(client: MovieHarborClient, path: string, contentId: string): Promise<PosterSnapshot> {
  const snapshot = parseApi(apiContentPosterDetail, await client.json('GET', path));
  if (snapshot.id !== contentId) throw new MovieHarborClientError('invalid_response');
  return snapshot;
}

// 上传异常时区分已知拒绝与可能提交的结果；格式错误和收尾失败保留原有机器码。
function posterWriteOutcomeCode(error: unknown): PosterWriteOutcome['code'] | undefined {
  if (!(error instanceof MovieHarborClientError)) return undefined;
  if (error.code === 'invalid_response' || error.code === 'media_replace_finalization_failed') return error.code;
  if (error instanceof UploadFileChangedAfterSendError
    || ['network_error', 'timeout', 'response_too_large', 'server_error', 'media_replace_outcome_unknown'].includes(error.code)) {
    return 'write_result_unknown';
  }
}

// 上传可能已提交时只读回查一次，收尾错误和相符槽位共同证明本次提交。
async function reconcilePosterWrite(
  client: MovieHarborClient,
  path: string,
  contentType: PosterWriteOutcome['content_type'],
  previous: PosterSnapshot,
  code: PosterWriteOutcome['code'],
): Promise<never> {
  const latest = await readPosterSnapshot(client, path, previous.id).catch(() => null);
  const previousId = previous.poster?.id.toLowerCase() ?? null;
  const currentId = latest?.poster?.id.toLowerCase() ?? null;
  // 单靠槽位变化无法排除并发更新，收尾错误码只在后端数据库提交后发出。
  const committed = code === 'media_replace_finalization_failed' && latest?.status === 'draft'
    && latest.version === previous.version + 1 && currentId !== null && currentId !== previousId;
  throw new PosterWriteOutcomeError({
    code,
    content_type: contentType,
    content_id: previous.id,
    previous_poster_id: previousId,
    current_poster_id: currentId,
    previous_version: previous.version,
    current_version: latest?.version ?? null,
    commit_status: committed ? 'committed' : 'unknown',
  });
}

// 在得到独立确认后上传海报，目标草稿的当前槽位决定补传或替换。
export async function setContentPoster(input: unknown, dependencies: PosterToolDependencies): Promise<ToolResult> {
  const parsed = setContentPosterInput.parse(input);
  const { client, allowedRoots } = dependencies;
  // 本地文件先通过预检，失败时不向远端查询或发出写入。
  const { poster, file } = await checkedPoster(parsed.path, allowedRoots);
  const collection = parsed.content_type === 'movie' ? 'movies' : 'series';
  const target = collection + '/' + parsed.content_id;
  const detailPath = '/api/admin/' + target;

  // 读取原槽位并核对归属、并发版本和草稿状态，只有匹配才允许上传。
  const current = await readPosterSnapshot(client, detailPath, parsed.content_id);
  if (current.version !== parsed.version) throw new MovieHarborClientError('version_conflict', 409);
  if (current.status !== 'draft') {
    throw new Error('只有草稿可以补传或替换海报，请先显式调用 transition_content_lifecycle 转为草稿。');
  }
  const action = current.poster === null ? 'added' : 'replaced';

  let uploaded: z.output<typeof apiContentPosterUpload>;
  try {
    // 将已核对版本交给现有流式上传和后端原子替换流程，期间发生并发修改时由后端拒绝。
    const response = await client.upload('/api/admin/media/' + target + '/poster?version=' + current.version,
      file, poster.mime_type);
    uploaded = parseApi(apiContentPosterUpload, response);
    // 资产必须对应这次上传并推进一次版本；替换时仍返回旧 ID 表示结果不一致。
    if (uploaded.id === current.poster?.id.toLowerCase() || uploaded.mime_type !== poster.mime_type
      || uploaded.byte_size !== file.identity.size || uploaded.version !== current.version + 1) {
      throw new MovieHarborClientError('invalid_response');
    }
  } catch (error) {
    const code = posterWriteOutcomeCode(error);
    // 仅在可能提交时核对当前槽位；回查失败也保留上传结果待确认语义。
    if (code) return reconcilePosterWrite(client, detailPath, parsed.content_type, current, code);
    throw error;
  }

  return toolResult(setContentPosterOutput, {
    content_type: parsed.content_type,
    content_id: current.id,
    version: uploaded.version,
    media_id: uploaded.id,
    format: poster.format,
    byte_size: uploaded.byte_size,
    action,
    next_actions: ['transition_content_lifecycle'],
  }, (action === 'added' ? '海报已补传。' : '海报已替换。') + '发布仍需单独确认。');
}

// 协议层保留稳定错误码和已读取的安全字段，供调用方核对提交结果。
async function posterResult(input: unknown, dependencies: PosterToolDependencies): Promise<CallToolResult> {
  try {
    return await setContentPoster(input, dependencies);
  } catch (error) {
    if (error instanceof PosterWriteOutcomeError) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: error.outcome,
      };
    }
    if (error instanceof MovieHarborClientError) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: { code: error.code },
      };
    }
    throw error;
  }
}

// 构建服务器时注册需要明确确认的电影和整剧海报维护工具。
export function registerPosterTools(server: McpServer, dependencies: PosterToolDependencies): void {
  server.registerTool('set_content_poster', {
    description: '经用户明确确认后，为电影或整剧草稿补传或替换本地海报。替换会永久移除旧海报。此工具不允许删除海报。非草稿先显式调用 transition_content_lifecycle 转草稿。',
    inputSchema: setContentPosterInput,
    outputSchema: setContentPosterOutput,
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, input => posterResult(input, dependencies));
}
