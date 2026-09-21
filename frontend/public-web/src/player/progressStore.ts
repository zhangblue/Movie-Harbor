import type { JsonObject, JsonValue } from "@movie-harbor/api-client";

export const PROGRESS_STORAGE_KEY = "movie-harbor:playback:v1";

export type PlaybackContentKey = `movie:${string}` | `episode:${string}`;
export type SeriesProgressKey = `series:${string}`;

export interface PlaybackProgress {
  position: number;
  duration: number;
  updatedAt: number;
}

interface ProgressState {
  version: 1;
  progress: Record<string, PlaybackProgress>;
  recentEpisodes: Record<string, string>;
}

const emptyState = (): ProgressState => ({ version: 1, progress: {}, recentEpisodes: {} });

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(storage?: Storage): ProgressState {
  const target = resolveStorage(storage);
  if (!target) return emptyState();
  try {
    const raw = target.getItem(PROGRESS_STORAGE_KEY);
    if (raw === null) return emptyState();
    const value = JSON.parse(raw) as JsonValue;
    if (!isJsonObject(value)) return emptyState();
    const { version, progress: storedProgress, recentEpisodes: storedRecentEpisodes } = value;
    if (
      version !== 1
      || storedProgress === undefined || !isJsonObject(storedProgress)
      || storedRecentEpisodes === undefined || !isJsonObject(storedRecentEpisodes)
    ) {
      return emptyState();
    }
    const progress: Record<string, PlaybackProgress> = {};
    for (const [key, item] of Object.entries(storedProgress)) {
      if (item === undefined || !isJsonObject(item)
        || typeof item.position !== "number" || !Number.isFinite(item.position) || item.position < 0
        || typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration <= 0
        || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) return emptyState();
      progress[key] = { position: item.position, duration: item.duration, updatedAt: item.updatedAt };
    }
    const recentEpisodes: Record<string, string> = {};
    for (const [key, episodeId] of Object.entries(storedRecentEpisodes)) {
      if (typeof episodeId !== "string" || episodeId.length === 0) return emptyState();
      recentEpisodes[key] = episodeId;
    }
    return { version: 1, progress, recentEpisodes };
  } catch {
    return emptyState();
  }
}

function writeState(state: ProgressState, storage?: Storage) {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browsers may deny or exhaust local storage. Playback must continue without persistence.
  }
}

export function getProgress(key: PlaybackContentKey, storage?: Storage): PlaybackProgress | null {
  return readState(storage).progress[key] ?? null;
}

export function saveProgress(key: PlaybackContentKey, position: number, duration: number, storage?: Storage) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration <= 0) return;
  if (position === 0 || duration - position < 30) {
    clearProgress(key, storage);
    return;
  }
  const state = readState(storage);
  state.progress[key] = { position, duration, updatedAt: Date.now() };
  writeState(state, storage);
}

export function clearProgress(key: PlaybackContentKey, storage?: Storage) {
  const state = readState(storage);
  delete state.progress[key];
  writeState(state, storage);
}

export function getRecentEpisode(key: SeriesProgressKey, storage?: Storage): string | null {
  return readState(storage).recentEpisodes[key] ?? null;
}

export function setRecentEpisode(key: SeriesProgressKey, episodeId: string | null, storage?: Storage) {
  const state = readState(storage);
  if (episodeId) state.recentEpisodes[key] = episodeId;
  else delete state.recentEpisodes[key];
  writeState(state, storage);
}
