import { mergeViewerProgress } from "@movie-harbor/api-client";
import {
  applyViewerProgressSnapshot,
  clearAnonymousProgress,
  discardProgressTarget,
  readProgressSnapshot,
  toMergeRequest,
} from "./progressStore";

// 当前会话同步指定普通用户的离线操作，并以身份代次保护规范快照写入。
export async function synchronizeViewerProgress(
  viewerId: string,
  isCurrent: () => boolean,
  storage?: Storage,
): Promise<boolean> {
  const request = toMergeRequest(readProgressSnapshot(viewerId, storage));
  try {
    const snapshot = await mergeViewerProgress(request);
    if (!isCurrent()) return false;
    for (const result of snapshot.results) {
      if (result.status === "rejected" && result.reason === "not_found") {
        discardProgressTarget(result.operation, result.id, viewerId, storage);
      }
    }
    applyViewerProgressSnapshot(snapshot, viewerId, storage);
    return true;
  } catch {
    // 网络或进度服务故障只保留离线队列，不能影响内容页面和播放器。
    return false;
  }
}

// 用户确认后把匿名空间作为一批离线操作合并；仅在当前身份完整确认后清空。
export async function mergeAnonymousProgress(
  viewerId: string,
  isCurrent: () => boolean,
  storage?: Storage,
): Promise<boolean> {
  const request = toMergeRequest(readProgressSnapshot(undefined, storage));
  try {
    const snapshot = await mergeViewerProgress(request);
    if (!isCurrent()) return false;
    applyViewerProgressSnapshot(snapshot, viewerId, storage);
    if (snapshot.results.every((result) => result.status !== "rejected")) clearAnonymousProgress(storage);
    return true;
  } catch {
    // 匿名数据必须保留到服务端确认，失败时让用户下次登录重试。
    return false;
  }
}
