import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { probeMedia, verifyRequiredEncoders, executeConversion } from '../../../tools/video-conversion/execute.mjs';
import { buildConversionPlan } from '../../../tools/video-conversion/plan.mjs';
import type { McpConfig } from '../config.js';
import { inspectAllowedFile, revalidateAllowedFile } from './path-policy.js';
import { durationSeconds, probeCheckedFile, serializeIdentity } from './media-inspector.js';
import { prepareGeneratedRoot, recordGeneratedFile } from './generated-files.js';

// 描述转换时的配置与可注入的媒体进程依赖。
export interface ConversionDependencies {
  config: McpConfig;
  credentialDirectory: string;
  probeMedia?: typeof probeMedia;
  buildConversionPlan?: typeof buildConversionPlan;
  verifyRequiredEncoders?: typeof verifyRequiredEncoders;
  executeConversion?: typeof executeConversion;
}
// 确认转换后检查输入、运行转换并登记生成文件。
export async function convertVideo(path: string, dependencies: ConversionDependencies) {
  const { config } = dependencies;
  // 转换进程启动前先限制输入路径，防止读取允许目录以外的文件。
  const file = await inspectAllowedFile(path, config.allowedRoots);
  const media = await probeCheckedFile(file, config.allowedRoots, dependencies.probeMedia);
  const plan = (dependencies.buildConversionPlan ?? buildConversionPlan)(media);
  try { await (dependencies.verifyRequiredEncoders ?? verifyRequiredEncoders)(plan.requiredEncoders); }
  catch (error) {
    if (/缺少所需编码器/.test(String(error))) throw new Error('FFmpeg 缺少所需编码器，请安装完整 FFmpeg 后重试');
    throw new Error('FFmpeg 未安装或不可执行，请检查安装和 PATH');
  }
  const root = await prepareGeneratedRoot(config);
  const outputPath = join(root, `${randomUUID()}.mp4`);
  // 探测与转换之间再次核对身份；文件替换时停止执行外部进程。
  await revalidateAllowedFile(file, config.allowedRoots);
  try { await (dependencies.executeConversion ?? executeConversion)({ inputPath: file.realPath, outputPath, media, plan }); }
  catch { throw new Error('视频转换失败或已中断，请检查 FFmpeg、输入文件和可用磁盘空间'); }
  // 登记失败时保留转换输出供人工检查，避免恢复过程误删原文件。
  const output = await recordGeneratedFile(outputPath, file, config, dependencies.credentialDirectory).catch(() => {
    throw new Error(`视频转换已完成，但生成文件登记失败，请保留并检查：${outputPath}`);
  });
  return { output_path: output.realPath, duration_seconds: durationSeconds(media), identity: serializeIdentity(output), source_identity: serializeIdentity(file) };
}
