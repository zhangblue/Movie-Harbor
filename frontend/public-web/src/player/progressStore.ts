import type { JsonObject, JsonValue } from "@movie-harbor/api-client";

export const PROGRESS_STORAGE_KEY = "movie-harbor:playback:v1";

// 本地播放进度的电影或单集键，避免不同内容互相覆盖。
export type PlaybackContentKey = `movie:${string}` | `episode:${string}`;
// 本地最近单集记录的剧集键，供剧集播放器读取。
export type SeriesProgressKey = `series:${string}`;

// 本地保存的播放位置、视频时长和更新时间，供恢复播放使用。
export interface PlaybackProgress {
  position: number;
  duration: number;
  updatedAt: number;
}

// 版本化本地状态，分别存放各内容进度和各剧集最近单集。
interface ProgressState {
  version: 1;
  progress: Record<string, PlaybackProgress>;
  recentEpisodes: Record<string, string>;
}

// 本地数据缺失或无效时创建空的版本化播放进度状态。
const emptyState = (): ProgressState => ({ version: 1, progress: {}, recentEpisodes: {} });

// 读写进度前选择注入的存储或浏览器本地存储，不可用时返回空。
function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// 判断 JSON 值是否为非数组对象，供读取对象字段前校验。
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 读取并校验本地播放记录，存储不可用或数据损坏时回退为空状态。
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

// 保存播放状态，浏览器拒绝存储时仍允许播放继续。
function writeState(state: ProgressState, storage?: Storage) {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browsers may deny or exhaust local storage. Playback must continue without persistence.
  }
}

// 在播放器初始化时读取指定内容的播放进度。
export function getProgress(key: PlaybackContentKey, storage?: Storage): PlaybackProgress | null {
  return readState(storage).progress[key] ?? null;
}

// 播放期间保存有效进度，开头或接近结尾时清除恢复记录。
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

// 播放结束或从头播放时删除指定内容的进度。
export function clearProgress(key: PlaybackContentKey, storage?: Storage) {
  const state = readState(storage);
  delete state.progress[key];
  writeState(state, storage);
}

// 进入剧集播放页时读取最近观看的单集。
export function getRecentEpisode(key: SeriesProgressKey, storage?: Storage): string | null {
  return readState(storage).recentEpisodes[key] ?? null;
}

// 选择单集或进入播放器时更新最近观看记录。
export function setRecentEpisode(key: SeriesProgressKey, episodeId: string | null, storage?: Storage) {
  const state = readState(storage);
  if (episodeId) state.recentEpisodes[key] = episodeId;
  else delete state.recentEpisodes[key];
  writeState(state, storage);
}
