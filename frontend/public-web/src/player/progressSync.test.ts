import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeViewerProgress } from "@movie-harbor/api-client";
import { getProgress, hasAnonymousProgress, readProgressSnapshot, saveProgress } from "./progressStore";
import { mergeAnonymousProgress, synchronizeViewerProgress } from "./progressSync";

vi.mock("@movie-harbor/api-client", async (importOriginal) => ({ ...(await importOriginal()), mergeViewerProgress: vi.fn() }));

// 同步测试使用内存 Storage，确保不会依赖浏览器持久状态。
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  // 返回当前条目数量。
  get length() { return this.#items.size; }
  // 清空全部条目。
  clear() { this.#items.clear(); }
  // 读取指定条目。
  getItem(key: string) { return this.#items.get(key) ?? null; }
  // 按索引读取键。
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  // 删除指定条目。
  removeItem(key: string) { this.#items.delete(key); }
  // 写入指定条目。
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

const api = vi.mocked(mergeViewerProgress);

// 验证登录用户的离线队列和规范快照同步规则。
describe("viewer progress synchronization", () => {
  let storage: Storage;
  // 每个用例使用独立存储和网络桩。
  beforeEach(() => { storage = new MemoryStorage(); vi.clearAllMocks(); });

  // 验证：提交本地操作并落入服务端规范快照。
  it("merges local operations and applies the canonical snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000);
    saveProgress("movie:m", 10, 100, storage, "viewer");
    api.mockResolvedValue({ progress: [{ kind: "movie", id: "m", position_seconds: 25, duration_seconds: 100, completed: false, updated_at: new Date(2_000).toISOString() }], cursors: [], results: [] });

    await synchronizeViewerProgress("viewer", () => true, storage);

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ progress: [expect.objectContaining({ id: "m", position_seconds: 10 })] }));
    expect(getProgress("movie:m", storage, "viewer")?.position).toBe(25);
  });

  // 验证：请求期间产生的较新本地位置不会被较旧快照覆盖。
  it("keeps a local write that is newer than a delayed response", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(3_000);
    saveProgress("movie:m", 10, 100, storage, "viewer");
    api.mockImplementation(async () => { saveProgress("movie:m", 30, 100, storage, "viewer"); return { progress: [{ kind: "movie", id: "m", position_seconds: 20, duration_seconds: 100, completed: false, updated_at: new Date(2_000).toISOString() }], cursors: [], results: [] }; });

    await synchronizeViewerProgress("viewer", () => true, storage);
    expect(getProgress("movie:m", storage, "viewer")?.position).toBe(30);
  });

  // 验证：身份代次失效后完全丢弃迟到响应。
  it("discards a response after the active viewer changes", async () => {
    saveProgress("movie:m", 10, 100, storage, "viewer");
    api.mockResolvedValue({ progress: [{ kind: "movie", id: "m", position_seconds: 40, duration_seconds: 100, completed: false, updated_at: new Date(Date.now() + 1_000).toISOString() }], cursors: [], results: [] });
    await synchronizeViewerProgress("viewer", () => false, storage);
    expect(getProgress("movie:m", storage, "viewer")?.position).toBe(10);
  });

  // 验证：不存在的目标会从本地队列移除，网络失败则完整保留。
  it("drops not-found targets but retains data after network failure", async () => {
    saveProgress("movie:gone", 10, 100, storage, "viewer");
    api.mockResolvedValueOnce({ progress: [], cursors: [], results: [{ operation: "progress", id: "gone", status: "rejected", reason: "not_found" }] });
    await synchronizeViewerProgress("viewer", () => true, storage);
    expect(getProgress("movie:gone", storage, "viewer")).toBeNull();

    saveProgress("movie:offline", 12, 100, storage, "viewer");
    api.mockRejectedValueOnce(new Error("offline"));
    await expect(synchronizeViewerProgress("viewer", () => true, storage)).resolves.toBe(false);
    expect(getProgress("movie:offline", storage, "viewer")?.position).toBe(12);
  });

  // 验证：匿名数据只在当前身份收到服务端确认后清空。
  it("clears anonymous data only after a successful current merge", async () => {
    saveProgress("movie:m", 10, 100, storage);
    api.mockResolvedValue({ progress: [], cursors: [], results: [{ operation: "progress", id: "m", status: "accepted" }] });
    await mergeAnonymousProgress("viewer", () => false, storage);
    expect(hasAnonymousProgress(storage)).toBe(true);
    await mergeAnonymousProgress("viewer", () => true, storage);
    expect(hasAnonymousProgress(storage)).toBe(false);
    expect(readProgressSnapshot("viewer", storage).version).toBe(2);
  });
});
