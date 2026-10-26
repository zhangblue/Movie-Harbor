import type { McpServer } from '@modelcontextprotocol/server';
import { inspectVideoInput, inspectVideoOutput, validatePosterInput, validatePosterOutput, convertVideoInput, convertVideoOutput, deleteGeneratedVideoInput, deleteGeneratedVideoOutput } from '../schemas/media.js';
import { inspectVideo, validatePoster } from '../services/media-inspector.js';
import { convertVideo, type ConversionDependencies } from '../services/video-converter.js';
import { deleteGeneratedFile } from '../services/generated-files.js';

export interface LocalMediaDependencies extends ConversionDependencies {}
function result<T extends Record<string, unknown>>(output: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}
export async function inspectVideoTool(input: { path: string }, dependencies: LocalMediaDependencies) {
  const { path } = inspectVideoInput.parse(input);
  return result(inspectVideoOutput.parse(await inspectVideo(path, dependencies.config.allowedRoots, dependencies.probeMedia, dependencies.buildConversionPlan)));
}
export async function validatePosterTool(input: { path: string }, dependencies: LocalMediaDependencies) {
  const { path } = validatePosterInput.parse(input);
  return result(validatePosterOutput.parse(await validatePoster(path, dependencies.config.allowedRoots)));
}
export async function convertVideoTool(input: { path: string; confirmed: boolean }, dependencies: LocalMediaDependencies) {
  if (input.confirmed !== true) throw new Error('视频转换需要明确确认');
  const { path } = convertVideoInput.parse(input);
  return result(convertVideoOutput.parse(await convertVideo(path, dependencies)));
}
export async function deleteGeneratedVideoTool(input: { path: string }, dependencies: LocalMediaDependencies) {
  const { path } = deleteGeneratedVideoInput.parse(input);
  await deleteGeneratedFile(path, dependencies.config, dependencies.credentialDirectory);
  return result(deleteGeneratedVideoOutput.parse({ path, deleted: true }));
}
export function registerLocalMediaTools(server: McpServer, dependencies: LocalMediaDependencies) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool('inspect_video', { description: '只读检查本地视频；网站上传校验仍为最终权威。', inputSchema: inspectVideoInput, outputSchema: inspectVideoOutput, annotations: readOnly }, input => inspectVideoTool(input, dependencies));
  server.registerTool('validate_poster', { description: '只读检查本地海报格式与基本结构；服务端完整解码为最终权威。', inputSchema: validatePosterInput, outputSchema: validatePosterOutput, annotations: readOnly }, input => validatePosterTool(input, dependencies));
  server.registerTool('convert_video', { description: '经明确确认后生成受控 MP4，保留原视频。', inputSchema: convertVideoInput, outputSchema: convertVideoOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, input => convertVideoTool(input, dependencies));
  server.registerTool('delete_generated_video', { description: '仅删除身份仍与生成记录相符的 MCP 转换视频。', inputSchema: deleteGeneratedVideoInput, outputSchema: deleteGeneratedVideoOutput, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, input => deleteGeneratedVideoTool(input, dependencies));
}
