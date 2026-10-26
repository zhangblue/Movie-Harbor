import { isAbsolute } from 'node:path';
import { z } from 'zod';

const localPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), '必须使用不含 NUL 的绝对路径');
export const inspectVideoInput = z.object({ path: localPath }).strict();
export const validatePosterInput = z.object({ path: localPath }).strict();
export const convertVideoInput = z.object({ path: localPath, confirmed: z.boolean() }).strict();
export const deleteGeneratedVideoInput = z.object({ path: localPath }).strict();
export const fileIdentity = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: z.number().int().nonnegative(), mtime_ms: z.number() });
const track = z.object({ index: z.number().int().nonnegative(), codec: z.string().nullable(), language: z.string().nullable(), title: z.string().nullable() });
const mode = z.enum(['copy', 'transcode']);
export const inspectVideoOutput = z.object({
  path: z.string(), duration_seconds: z.number().int().positive().nullable(), container: z.enum(['mp4', 'webm', 'mkv', 'unknown']),
  video: z.object({ index: z.number().int().nonnegative(), codec: z.string().nullable(), pixel_format: z.string().nullable() }),
  audio_tracks: z.array(track), subtitle_tracks: z.array(track),
  compatibility: z.object({ accepted: z.boolean(), reasons: z.array(z.string()), conversion_required: z.boolean() }),
  conversion_plan: z.object({ video_mode: mode, audio_modes: z.array(mode), subtitle_modes: z.array(mode), required_encoders: z.array(z.string()) }).nullable(),
  identity: fileIdentity,
});
export const validatePosterOutput = z.object({ path: z.string(), format: z.enum(['jpeg', 'png', 'webp']), mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']), byte_size: z.number().int().nonnegative(), identity: fileIdentity });
export const convertVideoOutput = z.object({ output_path: z.string(), duration_seconds: z.number().int().positive().nullable(), identity: fileIdentity, source_identity: fileIdentity });
export const deleteGeneratedVideoOutput = z.object({ path: z.string(), deleted: z.literal(true) });
export type FileIdentity = z.infer<typeof fileIdentity>;
