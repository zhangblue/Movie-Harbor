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

// 描述海报工具的管理 API 客户端和允许读取用户海报的目录。
export interface PosterToolDependencies {
  client: MovieHarborClient;
  allowedRoots: string[];
}

// 描述海报工具返回的已校验结构化结果和中文摘要。
type ToolResult = ReturnType<typeof toolResult>;
// 描述海报操作已校验的目标和本地路径。
type PosterInput = z.output<typeof setContentPosterInput>;

// 已发送海报上传请求但未取得结果时，要求调用者读取真实的槽位和版本。
class PosterWriteResultUnknownError extends Error {
  readonly code = 'write_result_unknown';

  // 上传断线或超时时创建不含连接细节的重新查询说明。
  constructor() {
    super('海报写入结果待确认，请重新查询目标的海报和版本。');
    this.name = 'PosterWriteResultUnknownError';
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

// 在得到独立确认后上传海报，目标草稿的当前槽位决定补传或替换。
export async function setContentPoster(input: unknown, dependencies: PosterToolDependencies): Promise<ToolResult> {
  const parsed = setContentPosterInput.parse(input);
  const { client, allowedRoots } = dependencies;
  // 本地文件先通过预检，失败时不向远端查询或发出写入。
  const { poster, file } = await checkedPoster(parsed.path, allowedRoots);
  const collection = parsed.content_type === 'movie' ? 'movies' : 'series';
  const target = collection + '/' + parsed.content_id;

  // 读取原槽位并核对归属、并发版本和草稿状态，只有匹配才允许上传。
  const current = parseApi(apiContentPosterDetail, await client.json('GET', '/api/admin/' + target));
  if (current.id !== parsed.content_id) throw new MovieHarborClientError('invalid_response');
  if (current.version !== parsed.version) throw new MovieHarborClientError('version_conflict', 409);
  if (current.status !== 'draft') {
    throw new Error('只有草稿可以补传或替换海报，请先显式调用 transition_content_lifecycle 转为草稿。');
  }
  const action = current.poster === null ? 'added' : 'replaced';

  // 将已核对版本交给现有流式上传和后端原子替换流程，期间发生并发修改时由后端拒绝。
  const response = await client.upload('/api/admin/media/' + target + '/poster?version=' + current.version,
    file, poster.mime_type).catch(error => {
    if (error instanceof MovieHarborClientError && (error.code === 'network_error' || error.code === 'timeout')) {
      throw new PosterWriteResultUnknownError();
    }
    throw error;
  });
  const uploaded = parseApi(apiContentPosterUpload, response);
  // 资产必须对应这次上传并推进一次版本；替换时仍返回旧 ID 表示结果不一致。
  if (uploaded.id === current.poster?.id.toLowerCase() || uploaded.mime_type !== poster.mime_type
    || uploaded.byte_size !== file.identity.size || uploaded.version !== current.version + 1) {
    throw new MovieHarborClientError('invalid_response');
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

// 协议层保留稳定错误码，上传结果待确认时附上重新查询的目标与入口。
async function posterResult(input: PosterInput, dependencies: PosterToolDependencies): Promise<CallToolResult> {
  try {
    return await setContentPoster(input, dependencies);
  } catch (error) {
    if (error instanceof PosterWriteResultUnknownError) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: {
          code: error.code,
          content_type: input.content_type,
          content_id: input.content_id,
          next_actions: [input.content_type === 'movie' ? 'search_movies' : 'search_series'],
        },
      };
    }
    if (error instanceof MovieHarborClientError) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.code === 'invalid_response'
          ? error.message + '，请重新查询目标的海报和版本。'
          : error.message }],
        structuredContent: { code: error.code },
      };
    }
    throw error;
  }
}

// 构建服务器时注册需要明确确认的电影和整剧海报维护工具。
export function registerPosterTools(server: McpServer, dependencies: PosterToolDependencies): void {
  server.registerTool('set_content_poster', {
    description: '经用户明确确认后，为电影或整剧草稿补传或替换本地海报。此工具不允许删除海报。非草稿先显式调用 transition_content_lifecycle 转草稿。',
    inputSchema: setContentPosterInput,
    outputSchema: setContentPosterOutput,
    annotations: writeAnnotations,
  }, input => posterResult(input, dependencies));
}
