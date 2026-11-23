import { mergeViewerProgress } from "@movie-harbor/api-client";
import {
  applyViewerProgressSnapshot,
  acknowledgeAnonymousProgress,
  acknowledgeViewerProgress,
  clearAnonymousProgress,
  readProgressSnapshot,
  toMergeRequest,
} from "./progressStore";

// 当前会话同步指定普通用户的离线操作，并以身份代次保护规范快照写入。
export async function synchronizeViewerProgress(
  viewerId: string,
  isCurrent: () => boolean,
  storage?: Storage,
): Promise<boolean> {
  try {
    let first = true;
    while (first || pendingCount(toMergeRequest(readProgressSnapshot(viewerId, storage))) > 0) {
      first = false;
      const request = toMergeRequest(readProgressSnapshot(viewerId, storage));
      const snapshot = await mergeViewerProgress(request);
      if (!isCurrent()) return false;
      acknowledgeViewerProgress(request, snapshot, viewerId, storage);
      applyViewerProgressSnapshot(snapshot, viewerId, storage);
      // 非法或不完整回执若没有推进队列则停止本轮，避免页面被无限同步阻塞。
      if (pendingCount(request) > 0
        && pendingCount(toMergeRequest(readProgressSnapshot(viewerId, storage))) >= pendingCount(request)) return false;
    }
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
  try {
    while (true) {
      const request = toMergeRequest(readProgressSnapshot(undefined, storage));
      if (pendingCount(request) === 0) break;
      const snapshot = await mergeViewerProgress(request);
      if (!isCurrent()) return false;
      applyViewerProgressSnapshot(snapshot, viewerId, storage);
      acknowledgeAnonymousProgress(request, storage);
    }
    if (!isCurrent()) return false;
    clearAnonymousProgress(storage);
    return true;
  } catch {
    // 匿名数据必须保留到服务端确认，失败时让用户下次登录重试。
    return false;
  }
}

// 统计批量协议中的实际操作数，供多批同步判断队列是否耗尽。
function pendingCount(request: ReturnType<typeof toMergeRequest>) {
  return request.progress.length + request.cursors.length + request.removals.length;
}
