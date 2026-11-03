import { z } from 'zod';
import { MovieHarborClientError } from '../services/error-mapper.js';

// 供内容和媒体 schema 校验标准 UUID 文本，也兼容旧数据的零版本位。
export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// 供版本、序号及时长等 schema 限制正安全整数。
export const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// 供读写内容工具校验并发版本，使用正安全整数。
export const version = positiveInt;
// 供搜索和创建工具校验去除首尾空格后的非空名称。
export const name = z.string().trim().min(1);
// 供电影和剧集工具限制年份为 1 至 9999 的整数。
export const year = z.number().int().min(1).max(9999);
// 限定内容 API 可存储的最大秒数，供时长 schema 和转换函数使用。
export const maxDurationSeconds = 2_147_483_647;
// 供创建电影和剧集工具要求非空简介。
export const synopsis = z.string().trim().min(1);
// 供内容创建工具限定公开或私密，未指定时默认公开。
export const visibility = z.enum(['public', 'private']).default('public');
// 供入库写工具要求显式确认为真，不作为 API 数据转发。
export const confirmed = z.literal(true);
// 供电影工具限制正整数分钟及后端支持的最大值。
export const durationMinutes = positiveInt.max(Math.floor(maxDurationSeconds / 60));
// 供单集工具限制正整数秒及后端支持的最大值。
export const duration = positiveInt.max(maxDurationSeconds);
// 供内容响应与输出限定草稿、已发布或已归档状态。
export const status = z.enum(['draft', 'published', 'archived']);
// 供工具结果列出可供调用方选择的后续操作。
export const nextActions = z.array(z.string());
// 供查询工具注册声明只读、非破坏和幂等属性。
export const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
// 供写工具注册声明非只读、非破坏且默认非幂等属性。
export const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
// 供电影和剧集写工具返回内容标识、版本、状态及后续操作。
export const contentResult = z.object({ id, version, status, next_actions: nextActions });

// 展示电影时长时将秒数四舍五入为至少一分钟。
export function durationMinutesFromSeconds(seconds: number | null): number | null {
  if (seconds === null) return null;
  return Math.max(1, Math.round(seconds / 60));
}
// 向 API 发送电影时长时将分钟转换为受限秒数。
export function durationSecondsFromMinutes(minutes: number): number {
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxDurationSeconds) {
    throw new Error('电影时长超出 Movie Harbor 支持范围');
  }
  return seconds;
}

// 写入单集时将秒数按分钟取整。
export function roundedDurationSeconds(seconds: number): number {
  return durationSecondsFromMinutes(durationMinutesFromSeconds(seconds)!);
}

// 比较候选名称时去除首尾空格并统一大小写。
export function normalizedName(value: string) { return value.trim().toLowerCase(); }
// 接收 API 响应或组装输出时校验并过滤字段。
export function parseApi<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MovieHarborClientError('invalid_response');
  return parsed.data;
}
// 工具返回时同时组装文本摘要与经校验的结构化结果。
export function toolResult<S extends z.ZodType<Record<string, unknown>>>(schema: S, value: unknown, summary: string) {
  // 返回前校验结构化字段；校验失败时不输出可能泄露额外数据的结果。
  return { content: [{ type: 'text' as const, text: summary }], structuredContent: parseApi(schema, value) };
}
