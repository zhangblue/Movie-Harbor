import { z } from 'zod';
import { MovieHarborClientError } from '../services/error-mapper.js';

// The backend and PostgreSQL accept canonical 8-4-4-4-12 UUID text even for
// legacy seeded rows whose RFC version and variant bits are zero.
export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const version = positiveInt;
export const name = z.string().trim().min(1);
export const year = z.number().int().min(1).max(9999);
export const maxDurationSeconds = 2_147_483_647;
export const synopsis = z.string().trim().min(1);
export const visibility = z.enum(['public', 'private']).default('public');
export const confirmed = z.literal(true);
export const durationMinutes = positiveInt.max(Math.floor(maxDurationSeconds / 60));
export const duration = positiveInt.max(maxDurationSeconds);
export const status = z.enum(['draft', 'published', 'archived']);
export const nextActions = z.array(z.string());
export const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const contentResult = z.object({ id, version, status, next_actions: nextActions });

export function durationMinutesFromSeconds(seconds: number | null): number | null {
  if (seconds === null) return null;
  return Math.max(1, Math.round(seconds / 60));
}
export function durationSecondsFromMinutes(minutes: number): number {
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxDurationSeconds) {
    throw new Error('电影时长超出 Movie Harbor 支持范围');
  }
  return seconds;
}

export function roundedDurationSeconds(seconds: number): number {
  return durationSecondsFromMinutes(durationMinutesFromSeconds(seconds)!);
}

export function normalizedName(value: string) { return value.trim().toLowerCase(); }
export function parseApi<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MovieHarborClientError('invalid_response');
  return parsed.data;
}
export function toolResult<S extends z.ZodType<Record<string, unknown>>>(schema: S, value: unknown, summary: string) {
  return { content: [{ type: 'text' as const, text: summary }], structuredContent: parseApi(schema, value) };
}
