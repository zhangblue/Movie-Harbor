import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { probeMedia } from '../../../tools/video-conversion/execute.mjs';
import { buildConversionPlan } from '../../../tools/video-conversion/plan.mjs';
import { inspectAllowedFile, revalidateAllowedFile, type CheckedFile } from './path-policy.js';
import type { FileIdentity } from '../schemas/media.js';

export function serializeIdentity(file: CheckedFile): FileIdentity {
  return { dev: file.identity.dev.toString(), ino: file.identity.ino.toString(), size: file.identity.size, mtime_ms: file.identity.mtimeMs };
}
export function durationSeconds(media: VideoConversion.Media): number | null {
  const duration = media.durationSeconds;
  return duration !== null && Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(Math.ceil(duration)) ? Math.ceil(duration) : null;
}
export async function probeCheckedFile(file: CheckedFile, roots: string[], probe = probeMedia) {
  await revalidateAllowedFile(file, roots);
  let media: VideoConversion.Media;
  try { media = await probe(file.realPath); }
  catch (error) {
    if (/未安装或不可执行/.test(String(error))) throw new Error('FFprobe 未安装或不可执行，请安装 FFmpeg（含 FFprobe）并检查 PATH');
    throw new Error('视频探测失败，请检查视频文件和 FFprobe');
  }
  await revalidateAllowedFile(file, roots);
  return media;
}
export async function inspectVideo(path: string, roots: string[], probe = probeMedia, planBuilder = buildConversionPlan) {
  const file = await inspectAllowedFile(path, roots);
  const media = await probeCheckedFile(file, roots, probe);
  const extension = extname(file.realPath).toLowerCase().slice(1);
  const container = extension === 'mp4' || extension === 'webm' || extension === 'mkv' ? extension : 'unknown';
  const accepted = container === 'mp4' || container === 'webm';
  let plan: VideoConversion.Plan | null = null;
  const reasons = accepted ? [] : ['视频容器需要转换为网站支持的 MP4'];
  try { plan = planBuilder(media); }
  catch (error) {
    if (!/不支持图像字幕/.test(String(error))) throw new Error('无法生成视频转换计划');
    reasons.push('不支持图像字幕，请先处理字幕后重试');
  }
  const track = (item: VideoConversion.Track) => ({ index: item.index, codec: item.codec,
    language: typeof item.tags?.language === 'string' ? item.tags.language : null,
    title: typeof item.tags?.title === 'string' ? item.tags.title : null });
  return { path, duration_seconds: durationSeconds(media), container, video: { index: media.video.index, codec: media.video.codec, pixel_format: media.video.pixelFormat ?? null },
    audio_tracks: media.audio.map(track), subtitle_tracks: media.subtitles.map(track),
    compatibility: { accepted, reasons, conversion_required: !accepted },
    conversion_plan: plan ? { video_mode: plan.video.mode, audio_modes: plan.audio.map(track => track.mode), subtitle_modes: plan.subtitles.map(track => track.mode), required_encoders: plan.requiredEncoders } : null,
    identity: serializeIdentity(file) };
}

export async function validatePoster(path: string, roots: string[]) {
  const file = await inspectAllowedFile(path, roots);
  const extension = extname(file.realPath).toLowerCase();
  const format = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.png' ? 'png' : extension === '.webp' ? 'webp' : null;
  if (!format) throw new Error('海报仅支持 jpg、jpeg、png 或 webp');
  await revalidateAllowedFile(file, roots);
  const handle = await open(file.realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let matches = false;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== file.identity.dev || info.ino !== file.identity.ino || Number(info.size) !== file.identity.size) throw new Error('文件已经变化，请重新检查');
    const head = Buffer.alloc(Math.min(file.identity.size, 64));
    const tail = Buffer.alloc(Math.min(file.identity.size, 12));
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, file.identity.size - tail.length);
    if (format === 'jpeg') matches = head.length >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && tail.at(-2) === 0xff && tail.at(-1) === 0xd9;
    else if (format === 'png') matches = head.length >= 33 && file.identity.size >= 45
      && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && head.readUInt32BE(8) === 13
      && head.toString('ascii', 12, 16) === 'IHDR' && head.readUInt32BE(16) > 0 && head.readUInt32BE(20) > 0
      && tail.equals(Buffer.from('0000000049454e44ae426082', 'hex'));
    else matches = head.length >= 20 && head.toString('ascii', 0, 4) === 'RIFF' && head.readUInt32LE(4) + 8 === file.identity.size
      && head.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(head.toString('ascii', 12, 16))
      && head.readUInt32LE(16) > 0 && head.readUInt32LE(16) <= file.identity.size - 20;
  } finally { await handle.close(); }
  await revalidateAllowedFile(file, roots);
  if (!matches) throw new Error('图片内容与扩展名不匹配');
  return { path, format, mime_type: `image/${format}` as 'image/jpeg' | 'image/png' | 'image/webp', byte_size: file.identity.size, identity: serializeIdentity(file) };
}
