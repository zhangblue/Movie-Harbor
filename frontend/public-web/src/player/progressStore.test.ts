import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROGRESS_STORAGE_KEY,
  clearProgress,
  getProgress,
  getRecentEpisode,
  saveProgress,
  setRecentEpisode,
} from "./progressStore";

// 播放测试中模拟浏览器 Storage 的内存实现，隔离测试记录。
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  // 读取内存存储的条目数，供测试检查存储状态。
  get length() { return this.#items.size; }
  // 清空模拟存储，供测试重置数据。
  clear() { this.#items.clear(); }
  // 从模拟存储读取键值，供播放进度测试使用。
  getItem(key: string) { return this.#items.get(key) ?? null; }
  // 按索引读取模拟存储键，供存储接口测试使用。
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  // 从模拟存储删除键值，供播放进度测试使用。
  removeItem(key: string) { this.#items.delete(key); }
  // 将键值写入模拟存储，供播放进度测试使用。
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

// 验证：分组验证播放进度的本地持久化。
describe("playback progress storage", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
  beforeEach(() => localStorage.clear());

  // 验证：电影和单集进度在同一版本化存储中按键隔离。
  it("isolates movie and episode progress in one versioned namespace", () => {
    saveProgress("movie:same-id", 61, 600);
    saveProgress("episode:same-id", 122, 900);

    expect(getProgress("movie:same-id")).toMatchObject({ position: 61, duration: 600 });
    expect(getProgress("episode:same-id")).toMatchObject({ position: 122, duration: 900 });
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual([PROGRESS_STORAGE_KEY]);
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)).toMatchObject({ version: 1 });
  });

  // 验证：清除已完成内容时不影响其他内容进度。
  it("clears a completed item without disturbing another content key", () => {
    saveProgress("movie:one", 60, 600);
    saveProgress("movie:two", 80, 600);
    saveProgress("movie:one", 575, 600);

    expect(getProgress("movie:one")).toBeNull();
    expect(getProgress("movie:two")?.position).toBe(80);
  });

  // 验证：播放刚开始时不创建恢复位置。
  it("does not create a resume point at the beginning", () => {
    saveProgress("movie:one", 0, 600);
    expect(getProgress("movie:one")).toBeNull();
  });

  // 验证：损坏或不兼容的本地数据按空状态处理。
  it.each([
    "not json",
    JSON.stringify({ version: 2, progress: {}, recentEpisodes: {} }),
    JSON.stringify({ version: 1, progress: { "movie:one": { position: "bad", duration: 90 } }, recentEpisodes: {} }),
  ])("treats corrupt or incompatible local data as empty", (stored) => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, stored);

    expect(getProgress("movie:one")).toBeNull();
    expect(getRecentEpisode("series:one")).toBeNull();
  });

  // 验证：存储操作抛错时安全回退并继续播放。
  it("falls back safely when storage operations throw", () => {
    const unavailable: Storage = {
      // 模拟受限存储读取条目数时抛错，供降级测试使用。
      get length(): number { throw new DOMException("blocked"); },
      // 模拟受限存储清空时抛错，供降级测试使用。
      clear() { throw new DOMException("blocked"); },
      // 模拟受限存储读取时抛错，供降级测试使用。
      getItem() { throw new DOMException("blocked"); },
      // 模拟受限存储枚举键时抛错，供降级测试使用。
      key() { throw new DOMException("blocked"); },
      // 模拟受限存储删除时抛错，供降级测试使用。
      removeItem() { throw new DOMException("blocked"); },
      // 模拟受限存储写入时抛错，供降级测试使用。
      setItem() { throw new DOMException("blocked"); },
    };

    expect(() => saveProgress("movie:one", 60, 600, unavailable)).not.toThrow();
    expect(getProgress("movie:one", unavailable)).toBeNull();
    expect(() => clearProgress("movie:one", unavailable)).not.toThrow();
    expect(() => setRecentEpisode("series:one", "ep-1", unavailable)).not.toThrow();
    expect(getRecentEpisode("series:one", unavailable)).toBeNull();
  });

  // 验证：按剧集记录和清除最近观看的单集。
  it("records and clears the most recently watched episode per series", () => {
    setRecentEpisode("series:one", "ep-1");
    setRecentEpisode("series:two", "ep-2");
    expect(getRecentEpisode("series:one")).toBe("ep-1");
    expect(getRecentEpisode("series:two")).toBe("ep-2");

    setRecentEpisode("series:one", null);
    expect(getRecentEpisode("series:one")).toBeNull();
    expect(getRecentEpisode("series:two")).toBe("ep-2");
  });
});
