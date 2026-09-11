import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROGRESS_STORAGE_KEY,
  clearProgress,
  getProgress,
  getRecentEpisode,
  saveProgress,
  setRecentEpisode,
} from "./progressStore";

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key: string) { return this.#items.get(key) ?? null; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string) { this.#items.delete(key); }
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

describe("playback progress storage", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
  beforeEach(() => localStorage.clear());

  it("isolates movie and episode progress in one versioned namespace", () => {
    saveProgress("movie:same-id", 61, 600);
    saveProgress("episode:same-id", 122, 900);

    expect(getProgress("movie:same-id")).toMatchObject({ position: 61, duration: 600 });
    expect(getProgress("episode:same-id")).toMatchObject({ position: 122, duration: 900 });
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual([PROGRESS_STORAGE_KEY]);
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)).toMatchObject({ version: 1 });
  });

  it("clears a completed item without disturbing another content key", () => {
    saveProgress("movie:one", 60, 600);
    saveProgress("movie:two", 80, 600);
    saveProgress("movie:one", 575, 600);

    expect(getProgress("movie:one")).toBeNull();
    expect(getProgress("movie:two")?.position).toBe(80);
  });

  it("does not create a resume point at the beginning", () => {
    saveProgress("movie:one", 0, 600);
    expect(getProgress("movie:one")).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, progress: {}, recentEpisodes: {} }),
    JSON.stringify({ version: 1, progress: { "movie:one": { position: "bad", duration: 90 } }, recentEpisodes: {} }),
  ])("treats corrupt or incompatible local data as empty", (stored) => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, stored);

    expect(getProgress("movie:one")).toBeNull();
    expect(getRecentEpisode("series:one")).toBeNull();
  });

  it("falls back safely when storage operations throw", () => {
    const unavailable: Storage = {
      get length(): number { throw new DOMException("blocked"); },
      clear() { throw new DOMException("blocked"); },
      getItem() { throw new DOMException("blocked"); },
      key() { throw new DOMException("blocked"); },
      removeItem() { throw new DOMException("blocked"); },
      setItem() { throw new DOMException("blocked"); },
    };

    expect(() => saveProgress("movie:one", 60, 600, unavailable)).not.toThrow();
    expect(getProgress("movie:one", unavailable)).toBeNull();
    expect(() => clearProgress("movie:one", unavailable)).not.toThrow();
    expect(() => setRecentEpisode("series:one", "ep-1", unavailable)).not.toThrow();
    expect(getRecentEpisode("series:one", unavailable)).toBeNull();
  });

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
