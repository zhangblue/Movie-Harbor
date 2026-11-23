import type { JsonObject, JsonValue, ViewerProgressMergeRequest, ViewerProgressSnapshot } from "@movie-harbor/api-client";

export const PROGRESS_STORAGE_KEY = "movie-harbor:playback:v1";
export type PlaybackContentKey = `movie:${string}` | `episode:${string}`;
export type SeriesProgressKey = `series:${string}`;
export type PlaybackRemovalKey = PlaybackContentKey | SeriesProgressKey;

// 本地播放位置及原始客户端时间，供恢复播放和离线冲突合并。
export interface PlaybackProgress { position: number; duration: number; updatedAt: number; completed: boolean; seriesId?: string }
// 剧集最近单集及原始客户端时间，供跨设备定位使用。
export interface SeriesCursor { episodeId: string; updatedAt: number }
// 版本 2 状态同时保存规范缓存和待同步操作。
export interface ProgressState {
  version: 2; progress: Record<string, PlaybackProgress>; cursors: Record<string, SeriesCursor>; removals: Record<string, number>;
  synced: { progress: Record<string, number>; cursors: Record<string, number>; removals: Record<string, number> };
}

// 创建无任何本地记录的版本 2 状态。
const emptyState = (): ProgressState => ({ version: 2, progress: {}, cursors: {}, removals: {}, synced: { progress: {}, cursors: {}, removals: {} } });
// 选择注入的存储或浏览器本地存储，受限环境返回空。
function resolveStorage(storage?: Storage): Storage | null { try { return storage ?? window.localStorage; } catch { return null; } }
// 判断 JSON 值是否为可读取字段的对象。
function isObject(value: JsonValue | undefined): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
// 为匿名空间和每个普通用户生成互不重叠的存储键。
function storageKey(viewerId?: string) { return viewerId ? `${PROGRESS_STORAGE_KEY}:viewer:${viewerId}` : PROGRESS_STORAGE_KEY; }
// 校验单条进度，版本 1 缺少完成状态时迁移为未完成。
function parseProgress(value: JsonValue | undefined): PlaybackProgress | null {
  if (!isObject(value) || typeof value.position !== "number" || !Number.isFinite(value.position) || value.position < 0
    || typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.position > value.duration
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
    || (value.completed !== undefined && typeof value.completed !== "boolean")) return null;
  return { position: value.position, duration: value.duration, updatedAt: value.updatedAt, completed: value.completed === true,
    ...(typeof value.seriesId === "string" ? { seriesId: value.seriesId } : {}) };
}
// 读取并校验版本化状态，同时兼容迁移版本 1 的最近单集。
function readState(storage?: Storage, viewerId?: string): ProgressState {
  const target = resolveStorage(storage); if (!target) return emptyState();
  try {
    const raw = target.getItem(storageKey(viewerId)); if (raw === null) return emptyState();
    const value = JSON.parse(raw) as JsonValue;
    if (!isObject(value) || (value.version !== 1 && value.version !== 2) || !isObject(value.progress)) return emptyState();
    const progress: Record<string, PlaybackProgress> = {};
    for (const [key, item] of Object.entries(value.progress)) { const parsed = parseProgress(item); if (!parsed) return emptyState(); progress[key] = parsed; }
    if (value.version === 1) {
      if (!isObject(value.recentEpisodes)) return emptyState();
      const cursors: Record<string, SeriesCursor> = {};
      for (const [key, episodeId] of Object.entries(value.recentEpisodes)) { if (typeof episodeId !== "string" || !episodeId) return emptyState(); cursors[key] = { episodeId, updatedAt: 0 }; }
      return { version: 2, progress, cursors, removals: {}, synced: { progress: {}, cursors: {}, removals: {} } };
    }
    if (!isObject(value.cursors) || !isObject(value.removals)) return emptyState();
    const cursors: Record<string, SeriesCursor> = {};
    for (const [key, item] of Object.entries(value.cursors)) {
      if (!isObject(item) || typeof item.episodeId !== "string" || !item.episodeId || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) return emptyState();
      cursors[key] = { episodeId: item.episodeId, updatedAt: item.updatedAt };
    }
    const removals: Record<string, number> = {};
    for (const [key, time] of Object.entries(value.removals)) { if (typeof time !== "number" || !Number.isFinite(time)) return emptyState(); removals[key] = time; }
    const synced = { progress: {} as Record<string, number>, cursors: {} as Record<string, number>, removals: {} as Record<string, number> };
    if (value.synced !== undefined) {
      if (!isObject(value.synced)) return emptyState();
      for (const name of ["progress", "cursors", "removals"] as const) {
        const source = value.synced[name]; if (!isObject(source)) return emptyState();
        for (const [key, time] of Object.entries(source)) { if (typeof time !== "number" || !Number.isFinite(time)) return emptyState(); synced[name][key] = time; }
      }
    }
    return { version: 2, progress, cursors, removals, synced };
  } catch { return emptyState(); }
}
// 持久化状态；浏览器拒绝写入时不影响视频播放。
function writeState(state: ProgressState, storage?: Storage, viewerId?: string) { try { resolveStorage(storage)?.setItem(storageKey(viewerId), JSON.stringify(state)); } catch { /* 离线缓存失败不阻断播放。 */ } }
// 同步引擎读取完整快照并返回独立副本。
export function readProgressSnapshot(viewerId?: string, storage?: Storage): ProgressState { return structuredClone(readState(storage, viewerId)); }
// 同步引擎写回合并后的完整快照。
export function writeProgressSnapshot(state: ProgressState, viewerId?: string, storage?: Storage) { writeState(state, storage, viewerId); }
// 播放器初始化时读取指定内容进度。
export function getProgress(key: PlaybackContentKey, storage?: Storage, viewerId?: string): PlaybackProgress | null { return readState(storage, viewerId).progress[key] ?? null; }
// 播放期间保存有效位置；接近结尾仍等待 ended 事件确认完成。
export function saveProgress(key: PlaybackContentKey, position: number, duration: number, storage?: Storage, viewerId?: string, seriesId?: string) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0 || duration <= 0 || position > duration) return null;
  const state = readState(storage, viewerId), updatedAt = Date.now();
  state.progress[key] = { position, duration, updatedAt, completed: false, ...(seriesId ? { seriesId } : {}) };
  writeState(state, storage, viewerId); return updatedAt;
}
// ended 事件保留完成记录，避免另一设备继续展示为未完成。
export function completeProgress(key: PlaybackContentKey, position: number, duration: number, storage?: Storage, viewerId?: string, seriesId?: string) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  const state = readState(storage, viewerId), updatedAt = Date.now();
  state.progress[key] = { position: Math.min(Math.max(position, 0), duration), duration, updatedAt, completed: true, ...(seriesId ? { seriesId } : {}) };
  writeState(state, storage, viewerId); return updatedAt;
}
// 用户移除续播目标时写墓碑并清理该范围的本地缓存。
export function markProgressRemoved(kind: "movie" | "episode" | "series", id: string, storage?: Storage, viewerId?: string) {
  const state = readState(storage, viewerId), key = `${kind}:${id}` as PlaybackRemovalKey;
  const removedAt = state.removals[key] !== state.synced.removals[key] && state.removals[key] !== undefined ? state.removals[key] : Date.now();
  state.removals[key] = removedAt;
  if (kind === "series") { delete state.cursors[key]; for (const [progressKey, progress] of Object.entries(state.progress)) if (progress.seriesId === id) delete state.progress[progressKey]; }
  else delete state.progress[key];
  writeState(state, storage, viewerId); return removedAt;
}
// 从头播放时删除当前位置并写入对应目标墓碑。
export function clearProgress(key: PlaybackContentKey, storage?: Storage, viewerId?: string) { const [kind, id] = key.split(":", 2) as ["movie" | "episode", string]; return markProgressRemoved(kind, id, storage, viewerId); }
// 进入剧集播放器时读取最近单集。
export function getRecentEpisode(key: SeriesProgressKey, storage?: Storage, viewerId?: string): string | null { return readState(storage, viewerId).cursors[key]?.episodeId ?? null; }
// 选择单集时更新带时间游标，清空时只删除本地游标。
export function setRecentEpisode(key: SeriesProgressKey, episodeId: string | null, storage?: Storage, viewerId?: string) {
  const state = readState(storage, viewerId); if (!episodeId) { delete state.cursors[key]; writeState(state, storage, viewerId); return null; }
  const updatedAt = Date.now(); state.cursors[key] = { episodeId, updatedAt }; writeState(state, storage, viewerId); return updatedAt;
}
// 把本地状态转换为后端批量协议，并把单批限制在最早的 500 个操作。
export function toMergeRequest(state: ProgressState): ViewerProgressMergeRequest {
  const all: Array<{ type: "progress" | "cursor" | "removal"; target: string; time: number; value: object }> = [];
  for (const [key, item] of Object.entries(state.progress)) { if (state.synced.progress[key] === item.updatedAt) continue; const [kind, id] = key.split(":", 2); all.push({ type: "progress", target: key, time: item.updatedAt, value: { kind, id, position_seconds: item.position, duration_seconds: item.duration, completed: item.completed, updated_at: new Date(item.updatedAt).toISOString() } }); }
  for (const [key, item] of Object.entries(state.cursors)) { if (state.synced.cursors[key] === item.updatedAt) continue; all.push({ type: "cursor", target: `cursor:${key}`, time: item.updatedAt, value: { series_id: key.slice(7), episode_id: item.episodeId, updated_at: new Date(item.updatedAt).toISOString() } }); }
  for (const [key, time] of Object.entries(state.removals)) { if (state.synced.removals[key] === time) continue; const [kind, id] = key.split(":", 2); all.push({ type: "removal", target: key, time, value: { kind, id, removed_at: new Date(time).toISOString() } }); }
  const targets = new Set<string>();
  const selected = all.sort((a, b) => a.time - b.time).filter((item) => {
    if (targets.has(item.target)) return false;
    targets.add(item.target); return true;
  }).slice(0, 500);
  return { progress: selected.filter(x => x.type === "progress").map(x => x.value) as ViewerProgressMergeRequest["progress"], cursors: selected.filter(x => x.type === "cursor").map(x => x.value) as ViewerProgressMergeRequest["cursors"], removals: selected.filter(x => x.type === "removal").map(x => x.value) as ViewerProgressMergeRequest["removals"] };
}
// 应用服务端规范快照；较新的本地写入不被迟到响应覆盖。
export function applyViewerProgressSnapshot(snapshot: ViewerProgressSnapshot, viewerId: string, storage?: Storage) {
  const state = readState(storage, viewerId);
  for (const item of snapshot.progress) { const key = `${item.kind}:${item.id}`, updatedAt = Date.parse(item.updated_at); if ((state.progress[key]?.updatedAt ?? -1) > updatedAt) continue; state.progress[key] = { position: item.position_seconds, duration: item.duration_seconds, completed: item.completed, updatedAt, ...(item.series_id ? { seriesId: item.series_id } : {}) }; }
  for (const item of snapshot.cursors) { const key = `series:${item.series_id}`, updatedAt = Date.parse(item.updated_at); if ((state.cursors[key]?.updatedAt ?? -1) > updatedAt) continue; state.cursors[key] = { episodeId: item.episode_id, updatedAt }; }
  writeState(state, storage, viewerId);
}

// 服务端确认一批操作后标记对应原始时间，并清除被规范快照排除的旧缓存。
export function acknowledgeViewerProgress(request: ViewerProgressMergeRequest, snapshot: ViewerProgressSnapshot, viewerId: string, storage?: Storage) {
  const state = readState(storage, viewerId);
  for (const item of request.progress) {
    const key = `${item.kind}:${item.id}`, time = Date.parse(item.updated_at);
    const result = snapshot.results.find((entry) => entry.operation === "progress" && entry.id === item.id);
    if (!result) { if (snapshot.progress.some((entry) => entry.kind === item.kind && entry.id === item.id)) state.synced.progress[key] = time; continue; }
    if (result.status === "rejected" || !snapshot.progress.some((entry) => entry.kind === item.kind && entry.id === item.id)) {
      if (state.progress[key]?.updatedAt === time) delete state.progress[key];
    } else state.synced.progress[key] = time;
  }
  for (const item of request.cursors) {
    const key = `series:${item.series_id}`, time = Date.parse(item.updated_at);
    const result = snapshot.results.find((entry) => entry.operation === "cursor" && entry.id === item.series_id);
    if (!result) { if (snapshot.cursors.some((entry) => entry.series_id === item.series_id)) state.synced.cursors[key] = time; continue; }
    if (result.status === "rejected" || !snapshot.cursors.some((entry) => entry.series_id === item.series_id)) {
      if (state.cursors[key]?.updatedAt === time) delete state.cursors[key];
    } else state.synced.cursors[key] = time;
  }
  for (const item of request.removals) {
    const key = `${item.kind}:${item.id}`, time = Date.parse(item.removed_at);
    const result = snapshot.results.find((entry) => entry.operation === "removal" && entry.id === item.id);
    if (result && result.status !== "rejected") state.synced.removals[key] = time;
    else if (result && state.removals[key] === time) delete state.removals[key];
  }
  writeState(state, storage, viewerId);
}

// 匿名批次得到逐项回执后只删除本次原始时间仍匹配的条目，保留在途新增内容。
export function acknowledgeAnonymousProgress(request: ViewerProgressMergeRequest, storage?: Storage) {
  const state = readState(storage);
  for (const item of request.progress) { const key = `${item.kind}:${item.id}`; if (state.progress[key]?.updatedAt === Date.parse(item.updated_at)) delete state.progress[key]; }
  for (const item of request.cursors) { const key = `series:${item.series_id}`; if (state.cursors[key]?.updatedAt === Date.parse(item.updated_at)) delete state.cursors[key]; }
  for (const item of request.removals) { const key = `${item.kind}:${item.id}`; if (state.removals[key] === Date.parse(item.removed_at)) delete state.removals[key]; }
  writeState(state, storage);
}
// 服务端拒绝不存在目标时清理对应离线操作，避免反复重试。
export function discardProgressTarget(operation: "progress" | "cursor" | "removal", id: string, viewerId: string, storage?: Storage) {
  const state = readState(storage, viewerId);
  if (operation === "cursor") delete state.cursors[`series:${id}`];
  else { const collection = operation === "progress" ? state.progress : state.removals; for (const key of Object.keys(collection)) if (key.endsWith(`:${id}`)) delete collection[key]; }
  writeState(state, storage, viewerId);
}
// 登录后判断匿名空间是否包含可选合并数据。
export function hasAnonymousProgress(storage?: Storage) { const state = readState(storage); return Object.keys(state.progress).length + Object.keys(state.cursors).length + Object.keys(state.removals).length > 0; }
// 服务端成功确认匿名批次后清空匿名空间。
export function clearAnonymousProgress(storage?: Storage) { try { resolveStorage(storage)?.removeItem(PROGRESS_STORAGE_KEY); } catch { /* 删除失败时保留以便重试。 */ } }

// 首页继续观看卡片需要的目标和本地进度。
export interface ContinueWatchingEntry { kind: "movie" | "series"; id: string; episodeId?: string; progress: PlaybackProgress }
// 按更新时间生成未完成续播候选，每部剧集只保留最近一集。
export function listContinueWatching(viewerId: string, storage?: Storage): ContinueWatchingEntry[] {
  const records = Object.entries(readState(storage, viewerId).progress).sort(([, a], [, b]) => b.updatedAt - a.updatedAt), seen = new Set<string>(), result: ContinueWatchingEntry[] = [];
  for (const [key, progress] of records) {
    if (progress.position <= 0) continue;
    if (key.startsWith("movie:")) {
      if (!progress.completed && progress.duration - progress.position >= 30) result.push({ kind: "movie", id: key.slice(6), progress });
    } else if (key.startsWith("episode:") && progress.seriesId && !seen.has(progress.seriesId)) {
      if (!progress.completed && progress.duration - progress.position < 30) continue;
      seen.add(progress.seriesId);
      result.push({ kind: "series", id: progress.seriesId, episodeId: key.slice(8), progress });
    }
  }
  return result;
}
