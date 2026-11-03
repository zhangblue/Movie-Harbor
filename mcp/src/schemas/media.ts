import { isAbsolute } from 'node:path';
import { z } from 'zod';

// 供本地媒体工具输入要求不含 NUL 的绝对路径，实际访问仍须校验允许目录。
const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
// 供视频检查工具严格接收待检查的本地路径。
export const inspectVideoInput = z.object({ path: localPath }).strict();
// 供海报验证工具严格接收用户提供的本地路径。
export const validatePosterInput = z.object({ path: localPath }).strict();
// 供视频转换工具严格接收本地路径和独立确认标记。
export const convertVideoInput = z.object({ path: localPath, confirmed: z.boolean() }).strict();
// 供生成视频删除工具严格接收待删除路径，登记校验另行执行。
export const deleteGeneratedVideoInput = z.object({ path: localPath }).strict();
// 供检查结果及生成文件登记使用设备号、inode、大小和修改时间。
export const fileIdentity = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: z.number().int().nonnegative(), mtime_ms: z.number() });
// 供视频检查输出限制轨道序号、编码、语言和标题字段。
const track = z.object({ index: z.number().int().nonnegative(), codec: z.string().nullable(), language: z.string().nullable(), title: z.string().nullable() });
// 供视频转换计划输出限定复制或转码两种轨道处理方式。
const mode = z.enum(['copy', 'transcode']);
// 供视频检查工具输出容器、轨道、兼容性、转换计划和文件身份。
export const inspectVideoOutput = z.object({
  path: z.string(), duration_seconds: z.number().int().positive().nullable(), container: z.enum(['mp4', 'webm', 'mkv', 'unknown']),
  video: z.object({ index: z.number().int().nonnegative(), codec: z.string().nullable(), pixel_format: z.string().nullable() }),
  audio_tracks: z.array(track), subtitle_tracks: z.array(track),
  compatibility: z.object({ accepted: z.boolean(), reasons: z.array(z.string()), conversion_required: z.boolean() }),
  conversion_plan: z.object({ video_mode: mode, audio_modes: z.array(mode), subtitle_modes: z.array(mode), required_encoders: z.array(z.string()) }).nullable(),
  identity: fileIdentity,
});
// 供海报验证工具输出受限格式、MIME、大小与文件身份。
export const validatePosterOutput = z.object({ path: z.string(), format: z.enum(['jpeg', 'png', 'webp']), mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']), byte_size: z.number().int().nonnegative(), identity: fileIdentity });
// 供视频转换工具输出生成路径、时长及生成文件和来源身份。
export const convertVideoOutput = z.object({ output_path: z.string(), duration_seconds: z.number().int().positive().nullable(), identity: fileIdentity, source_identity: fileIdentity });
// 供生成视频删除工具输出路径与成功删除标记。
export const deleteGeneratedVideoOutput = z.object({ path: z.string(), deleted: z.literal(true) });
// 描述媒体检查和生成文件登记时使用的可序列化文件身份。
export type FileIdentity = z.infer<typeof fileIdentity>;
