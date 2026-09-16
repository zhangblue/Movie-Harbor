import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCsrfToken, setCsrfToken, type EpisodeResponse, type SeriesResponse } from "@movie-harbor/api-client";
import { SeriesEditor } from "./SeriesEditor";
import { App } from "../app/App";
import { adminContentItem, adminContentPage, deferred, json, series, session } from "../test/server";

const base = "/api/admin/series/series-1";
const episodePath = `${base}/seasons/s1/episodes/e1`;
function episode(overrides: Partial<EpisodeResponse> = {}): EpisodeResponse {
  return { id: "e1", season_id: "s1", number: 1, name: "来信", duration_seconds: 2700, status: "draft", version: 2, video: null, published_at: null, archived_at: null, created_at: "2026-09-01", updated_at: "2026-09-01", ...overrides };
}
function detail(overrides: Partial<SeriesResponse> = {}) { return series({ status: "draft", seasons: [{ id: "s1", number: 1, episodes: [episode()] }], ...overrides }); }
type Request = { url: string; method: string; body: any; headers: Headers };
function fixture(initial = detail(), intercept?: (r: Request) => Response | Promise<Response> | undefined) {
  let current = initial; let sequence = 1;
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const r = { url, method: init.method ?? "GET", body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) };
    requests.push(r); const custom = intercept?.(r); if (custom) return custom;
    if (url.endsWith("/session")) return json(session);
    if (url.endsWith("/genres")) return json([{ id: "g1", name: "剧情", enabled: true, sort_order: 1 }]);
    if (url.startsWith("/api/admin/contents") && r.method === "GET") return json(adminContentPage([
      adminContentItem({ id: current.id, kind: "series", name: current.name, status: current.status, version: current.version, created_at: current.created_at, poster_url: current.poster?.url ?? null }),
    ]));
    if (url === "/api/admin/movies") return json([]);
    if (url === "/api/admin/series" && r.method === "GET") return json([current]);
    if (url === "/api/admin/series" && r.method === "POST") { current = detail({ name: r.body.name, version: 1, seasons: [], poster: null }); return json(current, 201); }
    if (url === base && r.method === "GET") return json(current);
    if (url === `${base}/delete-impact`) return json({ name: current.name, version: current.version, season_count: current.seasons.length, episode_count: current.seasons.flatMap((s) => s.episodes).length, media_count: Number(!!current.poster) + current.seasons.flatMap((s) => s.episodes).filter((ep) => ep.video).length });
    if (url.endsWith("/delete-impact") && url.includes("/episodes/")) { const ep = current.seasons.flatMap((s) => s.episodes).find((value) => url.includes(`/${value.id}/`))!; return json({ display_name: ep.name, version: ep.version, season_count: 0, episode_count: 1, media_count: ep.video ? 1 : 0 }); }
    if (url.endsWith("/delete-impact") && url.includes("/seasons/")) { const season = current.seasons.find((value) => url.includes(`/${value.id}/`))!; return json({ display_name: `第 ${season.number} 季`, version: current.version, season_count: 1, episode_count: season.episodes.length, media_count: season.episodes.filter((ep) => ep.video).length }); }
    if (url.startsWith("/api/admin/media/")) {
      const file = r.body.get("file") as File;
      const media = { id: "asset", url: "/media/new", local_path: "/media/new", original_name: file.name, mime_type: file.type, byte_size: file.size };
      current = { ...current, version: current.version + 1 };
      if (url.includes("/series/")) { current.poster = media; return json({ ...media, version: current.version }); }
      const id = url.split("/")[5]; const ep = current.seasons.flatMap((s) => s.episodes).find((e) => e.id === id)!;
      ep.video = media; ep.version++; return json({ ...media, version: ep.version, series_version: current.version });
    }
    if (url === base && r.method === "PATCH") { current = { ...current, ...r.body, version: current.version + 1 }; return json(current); }
    if (url === base && r.method === "DELETE") return json({ deleted_media_count: 1 });
    if (/\/series-1\/(publish|archive|draft)$/.test(url)) { current = { ...current, version: current.version + 1, status: url.endsWith("archive") ? "archived" : url.endsWith("draft") ? "draft" : "published" }; return json(current); }
    const seasonId = url.split("/")[6]; const season = current.seasons.find((s) => s.id === seasonId);
    if (url === `${base}/seasons`) { current = { ...current, version: current.version + 1, seasons: [...current.seasons, { id: `s${++sequence}`, number: r.body.number, episodes: [] }] }; return json(current, 201); }
    if (season && !url.includes("/episodes")) {
      if (r.method === "DELETE") { current.seasons = current.seasons.filter((s) => s.id !== season.id); current = { ...current, version: current.version + 1 }; return json({ deleted_media_count: season.episodes.filter((ep) => ep.video).length }); }
      else season.number = r.body.number;
      current = { ...current, version: current.version + 1 }; return json(current);
    }
    if (season && url.endsWith("/episodes")) { season.episodes.push(episode({ id: `e${++sequence}`, season_id: season.id, version: 1, name: r.body.name, number: r.body.number, duration_seconds: null })); current = { ...current, version: current.version + 1 }; return json(current, 201); }
    const ep = season?.episodes.find((e) => e.id === url.split("/")[8]);
    if (ep && season) {
      if (r.method === "GET") return json({ episode: ep, series_version: current.version });
      if (r.method === "DELETE") { season.episodes = season.episodes.filter((e) => e.id !== ep.id); current.version++; return json({ deleted_media_count: ep.video ? 1 : 0 }); }
      const value = r.method === "PATCH" ? { ...ep, ...r.body, version: ep.version + 1 } : { ...ep, version: ep.version + 1, status: url.endsWith("archive") ? "archived" : url.endsWith("draft") ? "draft" : "published" };
      season.episodes = season.episodes.map((e) => e.id === ep.id ? value : e); current = { ...current, version: current.version + 1 };
      return json({ episode: value, series_version: current.version });
    }
    throw new Error(`Unexpected ${r.method} ${url}`);
  });
  return requests;
}
beforeEach(() => { setCsrfToken("session-csrf"); let n = 0; vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${++n}`), revokeObjectURL: vi.fn() })); });
afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); });
function editor(id: string | null = "series-1") { return render(<SeriesEditor seriesId={id} onBack={() => {}} onExpired={() => {}} />); }
async function expandFirst(user: ReturnType<typeof userEvent.setup>) { await user.click(await screen.findByRole("button", { name: "展开第 1 季" })); }

it("shows each persisted episode video path and no path for an episode without a video", async () => {
  fixture(detail({ seasons: [{ id: "s1", number: 1, episodes: [
    episode({ id: "e1", video: {
      id: "video-1", url: "/media/video/ab/ab000000000000000000000000000001.mp4",
      local_path: "/media/video/ab/ab000000000000000000000000000001.mp4",
      original_name: "first.mp4", mime_type: "video/mp4", byte_size: 1,
    } }),
    episode({ id: "e2", name: "无视频", video: null }),
    episode({ id: "e3", name: "第二集", video: {
      id: "video-2", url: "/media/video/cd/cd000000000000000000000000000002.mp4",
      local_path: "/media/video/cd/cd000000000000000000000000000002.mp4",
      original_name: "second.mp4", mime_type: "video/mp4", byte_size: 2,
    } }),
  ] }] }));
  const user = userEvent.setup();
  editor();
  await expandFirst(user);
  expect(screen.getByText("/media/video/ab/ab000000000000000000000000000001.mp4")).toBeInTheDocument();
  expect(screen.getByText("/media/video/cd/cd000000000000000000000000000002.mp4")).toBeInTheDocument();
  const noVideoEpisode = screen.getByRole("form", { name: "第 1 集 · 无视频" });
  expect(within(noVideoEpisode).getByText("尚未上传视频")).toBeInTheDocument();
  expect(within(noVideoEpisode).queryByText("本地存储路径：")).not.toBeInTheDocument();
});

it("defaults existing seasons to independent accessible collapses without losing input", async () => {
  fixture(detail({ seasons: [
    { id: "s1", number: 1, episodes: [episode()] },
    { id: "s2", number: 2, episodes: [episode({ id: "e2", season_id: "s2", name: "回声" })] },
  ] }));
  const user = userEvent.setup();
  editor();

  const first = await screen.findByRole("button", { name: "展开第 1 季" });
  const second = screen.getByRole("button", { name: "展开第 2 季" });
  const firstCard = screen.getByRole("article", { name: "第 1 季" });
  const firstBodyId = first.getAttribute("aria-controls");
  const firstBody = firstBodyId ? document.getElementById(firstBodyId) : null;
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(firstBodyId).not.toBeNull();
  expect(firstCard).toContainElement(firstBody);
  expect(firstBody).toHaveAttribute("hidden");
  expect(second).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByText("1 集")).toHaveLength(2);
  expect(within(firstCard).getByLabelText("季序号")).not.toBeVisible();

  await user.click(first);
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
  expect(firstBody).not.toHaveAttribute("hidden");
  const name = within(firstCard).getByLabelText("单集名称");
  await user.type(name, "未保存");
  await user.click(second);
  expect(screen.getByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "折叠第 1 季" }));
  expect(screen.getByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  expect(within(firstCard).getByLabelText("单集名称")).toHaveValue("来信未保存");

  await user.click(within(firstCard).getByRole("button", { name: "添加一集" }));
  const draft = within(firstCard).getByRole("form", { name: "新单集草稿" });
  const draftName = within(draft).getByLabelText("单集名称");
  await user.type(draftName, "新草稿");
  await user.click(screen.getByRole("button", { name: "折叠第 1 季" }));
  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  expect(within(screen.getByRole("form", { name: "新单集草稿" })).getByLabelText("单集名称")).toHaveValue("新草稿");
});

it("collapses existing seasons when a draft enters view mode without resetting later view refreshes", async () => {
  fixture();
  const user = userEvent.setup();
  editor();
  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "发布剧集" }));
  await screen.findByRole("heading", { name: "查看剧集" });
  expect(await screen.findByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");

  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  await user.click(screen.getByRole("button", { name: "归档剧集" }));
  expect(await screen.findByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
});

it("opens only a newly added season and keeps opened seasons across hierarchy updates", async () => {
  fixture();
  const user = userEvent.setup();
  editor();

  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByText("单集草稿已保存。");
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "添加一季" }));
  expect(await screen.findByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("0 集")).toBeInTheDocument();
  expect(screen.getByRole("form", { name: "新单集草稿" })).toBeVisible();
});

it("renders the season save and delete actions at the same explicit height and bottom alignment", async () => {
  fixture();
  const user = userEvent.setup();
  editor();
  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));

  const save = screen.getByRole("button", { name: "保存季序号" });
  const remove = screen.getByRole("button", { name: "删除本季" });
  const numberForm = save.closest("form");
  const controls = numberForm?.parentElement;

  expect(numberForm).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(getComputedStyle(save).height).toBe("38px");
  expect(getComputedStyle(remove).height).toBe("38px");
  expect(getComputedStyle(numberForm as HTMLElement).alignItems).toBe("flex-end");
  expect(getComputedStyle(controls as HTMLElement).alignItems).toBe("flex-end");
});

it("stays on the series page, reports synchronous child deletion, and refreshes", async () => {
  const requests = fixture();
  const user = userEvent.setup();
  render(<SeriesEditor seriesId="series-1" onBack={() => {}} onExpired={() => {}} />);
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "删除单集" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除单集" }));
  await user.type(dialog.getByLabelText("输入完整内容名称"), "来信");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  expect(await screen.findByRole("status")).toHaveTextContent("内容及其媒体文件已删除");
  expect(screen.getByRole("heading", { name: "编辑剧集草稿" })).toBeInTheDocument();
  const deletionIndex = requests.findIndex((r) => r.url === episodePath && r.method === "DELETE");
  expect(requests.slice(deletionIndex + 1).some((r) => r.url === base && r.method === "GET")).toBe(true);
});

it("requires the authoritative child impact and deletes with its returned version", async () => {
  const requests = fixture(detail(), (r) => r.url === `${episodePath}/delete-impact`
    ? json({ display_name: "服务器最新单集名", version: 9, season_count: 0, episode_count: 1, media_count: 1 }) : undefined);
  const user = userEvent.setup(); editor();
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "删除单集" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除单集" }));
  expect(dialog.getByText("媒体文件：1")).toBeInTheDocument();
  expect(dialog.queryByText(/独占媒体|共享媒体|自动重试/)).not.toBeInTheDocument();
  await user.type(dialog.getByLabelText("输入完整内容名称"), "服务器最新单集名");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(requests.find((r) => r.url === episodePath && r.method === "DELETE")?.body).toEqual({ version: 9 }));
});

it("keeps a child deletion dialog and its form when media deletion fails", async () => {
  const requests = fixture(detail(), (r) => r.url === episodePath && r.method === "DELETE"
    ? json({ error: "media deletion failed", code: "media_delete_failed" }, 500)
    : undefined);
  const user = userEvent.setup(); editor();
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "删除单集" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除单集" }));
  await user.type(dialog.getByLabelText("输入完整内容名称"), "来信");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。");
  expect(dialog.getByLabelText("输入完整内容名称")).toHaveValue("来信");
  expect(requests.filter((r) => r.url === episodePath && r.method === "DELETE")).toHaveLength(1);
});

it("refreshes a committed child deletion and warns instead of offering a retry", async () => {
  let committed = false;
  const requests = fixture(detail(), (r) => {
    if (r.url === episodePath && r.method === "DELETE") {
      committed = true;
      return json({ error: "media deletion finalization failed", code: "media_delete_finalization_failed" }, 500);
    }
    if (committed && r.url === base && r.method === "GET") return json(detail({ version: 4, seasons: [] }));
  });
  const user = userEvent.setup(); editor();
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "删除单集" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除单集" }));
  await user.type(dialog.getByLabelText("输入完整内容名称"), "来信");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("内容已删除，但媒体文件清理未完成。请检查媒体目录权限并重启服务，系统将在启动时继续恢复。");
  expect(screen.queryByRole("dialog", { name: "永久删除单集" })).not.toBeInTheDocument();
  expect(screen.queryByText("来信")).not.toBeInTheDocument();
  const deletionIndex = requests.findIndex((r) => r.url === episodePath && r.method === "DELETE");
  expect(requests.slice(deletionIndex + 1).some((r) => r.url === base && r.method === "GET")).toBe(true);
});

it("reloads a committed series-poster replacement and shows the finalization warning", async () => {
  let committed = false;
  const authoritative = detail({ version: 5, poster: { id: "new-poster", url: "/media/new-poster", local_path: "/media/new-poster", original_name: "new.png", mime_type: "image/png", byte_size: 3 } });
  fixture(detail(), (r) => {
    if (r.url.includes("/media/series/") && r.method === "POST") {
      committed = true;
      return json({ error: "media replacement finalization failed", code: "media_replace_finalization_failed" }, 500);
    }
    if (committed && r.url === base && r.method === "GET") return json(authoritative);
  });
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["new"], "new.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "保存剧集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
  expect(screen.getByRole("link", { name: /已保存海报/ })).toHaveAttribute("href", "/media/new-poster");
  expect(screen.queryByText(/待上传：new.png/)).not.toBeInTheDocument();
});

it("reloads a committed episode-video replacement and clears its pending file", async () => {
  let committed = false;
  const savedVideo = { id: "new-video", url: "/media/new-video", local_path: "/media/new-video", original_name: "new.mp4", mime_type: "video/mp4", byte_size: 3 };
  const authoritative = detail({ version: 5, seasons: [{ id: "s1", number: 1, episodes: [episode({ version: 4, video: savedVideo })] }] });
  fixture(detail(), (r) => {
    if (r.url.includes("/api/admin/media/episodes/") && r.method === "POST") {
      committed = true;
      return json({ error: "media replacement finalization failed", code: "media_replace_finalization_failed" }, 500);
    }
    if (committed && r.url === base && r.method === "GET") return json(authoritative);
  });
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.upload(screen.getByLabelText("视频文件"), new File(["new"], "new.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
  expect(screen.getByRole("link", { name: /已保存视频/ })).toHaveAttribute("href", "/media/new-video");
  expect(screen.queryByText(/待上传：new.mp4/)).not.toBeInTheDocument();
});

it("a series-poster finalization clears only that target and retains a pending episode video", async () => {
  let committed = false;
  const authoritative = detail({ version: 5, poster: { id: "new-poster", url: "/media/new-poster", local_path: "/media/new-poster", original_name: "new.png", mime_type: "image/png", byte_size: 3 } });
  const requests = fixture(detail(), (r) => {
    if (r.url.includes("/api/admin/media/series/") && r.method === "POST") {
      committed = true;
      return json({ error: "media replacement finalization failed", code: "media_replace_finalization_failed" }, 500);
    }
    if (committed && r.url === base && r.method === "GET") return json(authoritative);
  });
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["poster"], "new.png", { type: "image/png" }));
  await user.upload(screen.getByLabelText("视频文件"), new File(["video"], "later.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存剧集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
  expect(screen.queryByText(/待上传：new.png/)).not.toBeInTheDocument();
  expect(screen.getByText(/待上传：later.mp4/)).toBeInTheDocument();
  expect(requests.filter((r) => r.url.includes("/api/admin/media/")).map((r) => r.url)).toEqual(["/api/admin/media/series/series-1/poster?version=4"]);
});

it("an episode finalization clears only its video and retains a pending series poster", async () => {
  let committed = false;
  const savedVideo = { id: "new-video", url: "/media/new-video", local_path: "/media/new-video", original_name: "new.mp4", mime_type: "video/mp4", byte_size: 3 };
  const authoritative = detail({ version: 5, seasons: [{ id: "s1", number: 1, episodes: [episode({ version: 4, video: savedVideo })] }] });
  fixture(detail(), (r) => {
    if (r.url.includes("/api/admin/media/episodes/") && r.method === "POST") {
      committed = true;
      return json({ error: "media replacement finalization failed", code: "media_replace_finalization_failed" }, 500);
    }
    if (committed && r.url === base && r.method === "GET") return json(authoritative);
  });
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.upload(screen.getByLabelText("海报文件"), new File(["poster"], "later.png", { type: "image/png" }));
  await user.upload(screen.getByLabelText("视频文件"), new File(["video"], "new.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
  expect(screen.queryByText(/待上传：new.mp4/)).not.toBeInTheDocument();
  expect(screen.getByText(/待上传：later.png/)).toBeInTheDocument();
});

it("returns from a committed whole-series deletion and leaves a persistent warning", async () => {
  let committed = false;
  fixture(detail(), (r) => {
    if (r.url === base && r.method === "DELETE") {
      committed = true;
      return json({ error: "media deletion finalization failed", code: "media_delete_finalization_failed" }, 500);
    }
    if (committed && r.url.startsWith("/api/admin/contents") && r.method === "GET") return json(adminContentPage([]));
  });
  const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /长夜航线/ })).getByRole("button", { name: "编辑" }));
  await user.click(await screen.findByRole("button", { name: "永久删除剧集" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除剧集" }));
  await user.type(dialog.getByLabelText("输入完整内容名称"), "长夜航线");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  expect(await screen.findByRole("heading", { name: "内容管理" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("内容已删除，但媒体文件清理未完成。请检查媒体目录权限并重启服务，系统将在启动时继续恢复。");
  expect(screen.queryByRole("dialog", { name: "永久删除剧集" })).not.toBeInTheDocument();
});

it("uses the fixed replacement failure message and keeps the original series poster", async () => {
  fixture(detail(), (r) => r.url.includes("/media/series/")
    ? json({ error: "replacement failed", code: "media_replace_failed" }, 500)
    : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["poster"], "new.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "保存剧集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("替换失败，原媒体文件已保留，请检查媒体目录权限后重试。");
  expect(screen.getByRole("link", { name: /已保存海报/ })).toBeInTheDocument();
});

it("shows a localized upload message for a media content mismatch", async () => {
  fixture(detail(), (r) => r.url.includes("/media/series/")
    ? json({ error: "media content does not match its declared type", code: "media_content_mismatch" }, 415)
    : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["not an image"], "broken.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "保存剧集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("上传失败：文件内容与声明的类型不匹配，请确认文件格式正确且未损坏。");
});

it("does not open child deletion confirmation when authoritative impact cannot load", async () => {
  const requests = fixture(detail(), (r) => r.url === `${episodePath}/delete-impact`
    ? json({ error: "offline" }, 503) : undefined);
  const user = userEvent.setup(); editor();
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "删除单集" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog", { name: "永久删除单集" })).not.toBeInTheDocument();
  expect(requests.some((r) => r.url === episodePath && r.method === "DELETE")).toBe(false);
});

// Absent fields, accidental season titles, leaked preview URLs, or resetting a cancelled picker fail here.
it("loads basic information and number-only seasons with a disposable poster preview", async () => {
  fixture(); const user = userEvent.setup(); const view = editor();
  expect(await screen.findByLabelText("剧集名称")).toHaveValue("长夜航线");
  expect(screen.getByLabelText("首播年份")).toHaveValue(2026);
  expect(screen.getByRole("heading", { name: "基本信息" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "季与单集" })).toBeInTheDocument();
  expect(screen.getByLabelText("季序号")).toHaveValue(1);
  expect(screen.queryByLabelText("季名称")).not.toBeInTheDocument();
  const input = screen.getByLabelText("海报文件");
  await user.upload(input, new File(["a"], "a.png", { type: "image/png" }));
  fireEvent.change(input, { target: { files: [] } });
  expect(screen.getByRole("img")).toHaveAttribute("src", "blob:1");
  await user.upload(input, new File(["b"], "b.png", { type: "image/png" }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2");
});

it("creates a named series and one season, requiring the administrator to name its initial episode", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor(null);
  await user.type(await screen.findByLabelText("剧集名称"), "新剧"); await user.click(screen.getByRole("button", { name: "创建草稿" }));
  const name = await screen.findByLabelText("单集名称"); expect(name).toHaveValue("");
  expect(within(screen.getByRole("form", { name: "新单集草稿" })).getByText("保存单集草稿后可填写时长并上传视频。")).toBeInTheDocument();
  expect(screen.getAllByLabelText("季序号")).toHaveLength(1); expect(screen.getAllByLabelText("集序号")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  expect(requests.filter((r) => r.url.endsWith("/episodes"))).toHaveLength(0);
  await user.type(name, "第一封信"); await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByText("单集草稿已保存。");
  expect(requests.find((r) => r.url.endsWith("/episodes"))?.body).toEqual({ version: 2, number: 1, name: "第一封信" });
});

// Catches leaving App keyed to the pre-create null identity and losing the initial episode row.
it("keeps the created series identity and initial episode when navigating away and back", async () => {
  const requests = fixture(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: /新建内容/ }));
  await user.selectOptions(screen.getByLabelText("新建内容形态"), "series");
  await user.type(await screen.findByLabelText("剧集名称"), "可恢复新剧");
  await user.click(screen.getByRole("button", { name: "创建草稿" }));
  expect(await screen.findByLabelText("单集名称")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "系统设置" }));
  await user.click(screen.getByRole("button", { name: "内容管理" }));
  expect(await screen.findByLabelText("剧集名称")).toHaveValue("可恢复新剧");
  expect(screen.getByLabelText("单集名称")).toHaveValue("");
  expect(requests.filter((r) => r.url === "/api/admin/series" && r.method === "POST")).toHaveLength(1);
});

// Catches an inaccessible orphan when series creation succeeds but default-season creation fails.
it("preserves a partially initialized series so its first season can be retried explicitly", async () => {
  let failInitialSeason = true;
  const requests = fixture(undefined, (r) => r.url.endsWith("/seasons") && r.method === "POST" && failInitialSeason ? json({ error: "offline" }, 503) : undefined);
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: /新建内容/ }));
  await user.selectOptions(screen.getByLabelText("新建内容形态"), "series");
  await user.type(await screen.findByLabelText("剧集名称"), "未完成新剧");
  await user.click(screen.getByRole("button", { name: "创建草稿" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "系统设置" }));
  await user.click(screen.getByRole("button", { name: "内容管理" }));
  expect(await screen.findByLabelText("剧集名称")).toHaveValue("未完成新剧");
  failInitialSeason = false;
  await user.click(screen.getByRole("button", { name: "添加一季" }));
  expect(await screen.findByLabelText("单集名称")).toHaveValue("");
  expect(requests.filter((r) => r.url === "/api/admin/series" && r.method === "POST")).toHaveLength(1);
});

// Catches publishing with the pre-save/pre-upload parent version or leaking the poster preview.
it("chains the saved series and poster versions into publication", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor();
  await screen.findByLabelText("剧集名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["poster"], "series.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "发布剧集" }));
  await waitFor(() => expect(screen.getByLabelText("剧集名称")).toBeDisabled());
  const writes = requests.filter((r) => r.method !== "GET");
  expect(writes.map((r) => r.url)).toEqual([base, "/api/admin/media/series/series-1/poster?version=4", `${base}/publish`]);
  expect(writes[2].body).toEqual({ version: 5 });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
});

it("explains that a series needs a published playable episode without requiring a poster", async () => {
  fixture(detail({ poster: null }), (r) => r.url.endsWith("/publish")
    ? json({ error: "validation", fields: ["poster", "episodes"] }, 422)
    : undefined);
  const user = userEvent.setup();
  editor();
  await screen.findByLabelText("剧集名称");
  await user.click(screen.getByRole("button", { name: "发布剧集" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("发布剧集失败：当前剧集没有已发布的单集。请先为单集上传可播放视频并发布至少一集，然后再发布整个剧集。");
  expect(alert).not.toHaveTextContent("海报");
});

// Ensures the update/upload boundary is one episode and propagates both versions to later writes.
it("saves one episode and its video independently, retaining another episode's unsaved input", async () => {
  const requests = fixture(detail({ seasons: [{ id: "s1", number: 1, episodes: [episode(), episode({ id: "e2", number: 2, name: "回信" })] }] }));
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.type(screen.getAllByLabelText("单集名称")[1], "未保存");
  await user.upload(screen.getAllByLabelText("视频文件")[0], new File(["v"], "one.mp4", { type: "video/mp4" }));
  await user.click(screen.getAllByRole("button", { name: "保存单集草稿" })[0]);
  await screen.findByText("单集草稿已保存。");
  expect(screen.getAllByLabelText("单集名称")[1]).toHaveValue("回信未保存");
  await user.click(screen.getByRole("button", { name: "添加一季" })); await screen.findByRole("heading", { name: "第 2 季" });
  const writes = requests.filter((r) => r.method !== "GET");
  expect(writes.map((r) => r.url)).toEqual([episodePath, "/api/admin/media/episodes/e1/video?version=3", `${base}/seasons`]);
  expect(writes[0].body).toEqual({ version: 2, number: 1, name: "来信", duration_seconds: 2700 });
  expect(writes[2].body).toEqual({ version: 5, number: 2 });
});

it("does not render or submit an episode synopsis", async () => {
  const requests = fixture(detail());
  const user = userEvent.setup();
  editor();
  await expandFirst(user);
  await screen.findByLabelText("单集名称");
  expect(screen.queryByLabelText("单集简介")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  expect(requests.find((request) => request.method === "PATCH" && request.url === episodePath)?.body)
    .toEqual({ version: 2, number: 1, name: "来信", duration_seconds: 2700 });
});

it("locks published series fields and seasons with published episodes while permitting new drafts", async () => {
  fixture(detail({ status: "published", seasons: [{ id: "s1", number: 1, episodes: [episode({ status: "published" })] }] }));
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  expect(screen.getByLabelText("剧集名称")).toBeDisabled(); expect(screen.queryByLabelText("海报文件")).not.toBeInTheDocument();
  expect(screen.getByLabelText("季序号")).toBeDisabled(); expect(screen.getByRole("button", { name: "删除本季" })).toBeDisabled();
  expect(screen.getByLabelText("单集名称")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "添加一集" }));
  expect(screen.getAllByLabelText("单集名称")[1]).toBeEnabled(); expect(screen.getByRole("button", { name: "添加一季" })).toBeEnabled();
});

// Catches incorrectly freezing descendants merely because the parent series itself is archived.
it("keeps an archived parent's fields read-only while preserving draft child editing", async () => {
  fixture(detail({ status: "archived" })); const user = userEvent.setup(); editor();
  await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  expect(screen.getByLabelText("剧集名称")).toBeDisabled();
  expect(screen.queryByLabelText("海报文件")).not.toBeInTheDocument();
  expect(screen.getByLabelText("单集名称")).toBeEnabled();
  expect(screen.getByRole("button", { name: "添加一季" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByText("单集草稿已保存。");
});

// Catches calculating the next draft number from stale initial values after an unsaved edit.
it("numbers the next unsaved episode after the highest currently entered draft number", async () => {
  fixture(); const user = userEvent.setup(); editor(); await expandFirst(user); await screen.findByLabelText("单集名称");
  await user.click(screen.getByRole("button", { name: "添加一集" }));
  const numbers = screen.getAllByLabelText("集序号");
  await user.clear(numbers[1]); await user.type(numbers[1], "5");
  await user.click(screen.getByRole("button", { name: "添加一集" }));
  expect(screen.getAllByLabelText("集序号")[2]).toHaveValue(6);
});

it("reloads the full hierarchy after episode transitions and derives season locks from the result", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor(); await expandFirst(user); await screen.findByLabelText("单集名称");
  await user.click(screen.getByRole("button", { name: "发布单集" }));
  await waitFor(() => expect(screen.getByLabelText("季序号")).toBeDisabled());
  await user.click(screen.getByRole("button", { name: "归档单集" }));
  await waitFor(() => expect(screen.getByLabelText("季序号")).toBeEnabled());
  for (const r of requests.filter((r) => /\/(publish|archive)$/.test(r.url))) expect(requests[requests.indexOf(r) + 1].url).toBe(base);
});

it("reloads the parent lifecycle and locks all writes if its follow-up read fails", async () => {
  let reads = 0; const requests = fixture(detail({ status: "published" }), (r) => r.url === base && r.method === "GET" && ++reads > 1 ? json({ error: "offline" }, 503) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.click(screen.getByRole("button", { name: "归档剧集" })); await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "添加一季" })).toBeDisabled(); expect(requests.at(-1)?.url).toBe(base);
});

it("adds and removes season and episode drafts with fresh, name-confirmed deletion scope", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.click(screen.getByRole("button", { name: "删除单集" }));
  let dialog = within(await screen.findByRole("dialog")); expect(dialog.getByText("单集：1")).toBeInTheDocument();
  await user.type(dialog.getByLabelText("输入完整内容名称"), "来信"); await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(screen.queryByLabelText("单集名称")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "删除本季" })); dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("季：1")).toBeInTheDocument(); await user.type(dialog.getByLabelText("输入完整内容名称"), "第 1 季"); await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(screen.queryByLabelText("季序号")).not.toBeInTheDocument());
  expect(requests.filter((r) => r.method === "DELETE").map((r) => r.body.version)).toEqual([2, 4]);
});

it("locks on conflict and only restores editing after an explicit reload", async () => {
  const requests = fixture(detail(), (r) => r.method === "PATCH" ? json({ error: "changed" }, 409) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称"); await expandFirst(user); await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "添加一季" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重新加载" })); await waitFor(() => expect(screen.getByRole("button", { name: "添加一季" })).toBeEnabled());
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});

it.each([401, 403])("recovers %s without replaying the rejected write", async (status) => {
  const requests = fixture(detail(), (r) => r.method === "PATCH" ? json({ error: "denied" }, status) : undefined);
  const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /长夜航线/ })).getByRole("button", { name: "编辑" }));
  await expandFirst(user);
  await user.click(await screen.findByRole("button", { name: "保存单集草稿" }));
  if (status === 401) await screen.findByRole("heading", { name: "管理员登录" }); else expect(await screen.findByRole("alert")).toHaveTextContent(/重新执行/);
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});

it("uses the renewed CSRF token only after an explicit retry of a forbidden write", async () => {
  let token = "session-csrf";
  const requests = fixture(detail(), (r) => {
    if (r.url.endsWith("/session")) return json({ ...session, csrf_token: token });
    if (r.method === "PATCH") return r.headers.get("X-CSRF-Token") === token ? undefined : json({ error: "denied" }, 403);
  });
  const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /长夜航线/ })).getByRole("button", { name: "编辑" }));
  await expandFirst(user);
  token = "renewed-csrf";
  await user.click(await screen.findByRole("button", { name: "保存单集草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/重新执行/);
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByText("单集草稿已保存。");
  expect(requests.filter((r) => r.method === "PATCH").map((r) => r.headers.get("X-CSRF-Token"))).toEqual(["session-csrf", "renewed-csrf"]);
});

it.each(["published", "archived"] as const)("opens a %s series from the content list with its seasons collapsed", async (status) => {
  fixture(detail({ status }));
  const user = userEvent.setup();
  render(<App />);
  const row = within(await screen.findByRole("row", { name: /长夜航线/ }));
  await user.click(row.getByRole("button", { name: "查看" }));
  expect(await screen.findByRole("heading", { name: "查看剧集" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");
});

it("opens series creation from the content kind selector and deletion from a list row", async () => {
  const requests = fixture(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: /新建内容/ })); await user.selectOptions(screen.getByLabelText("新建内容形态"), "series");
  expect(await screen.findByLabelText("剧集名称")).toHaveValue(""); await user.click(screen.getByRole("button", { name: "返回列表" }));
  await user.click(within(await screen.findByRole("row", { name: /长夜航线/ })).getByRole("button", { name: "永久删除" }));
  const dialog = within(await screen.findByRole("dialog")); expect(dialog.getByText("季：1")).toBeInTheDocument(); expect(dialog.getByText("单集：1")).toBeInTheDocument();
  await user.type(dialog.getByLabelText("输入完整内容名称"), "长夜航线 "); expect(dialog.getByRole("button", { name: "确认永久删除" })).toBeDisabled();
  await user.clear(dialog.getByLabelText("输入完整内容名称")); await user.type(dialog.getByLabelText("输入完整内容名称"), "长夜航线"); await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  await screen.findByRole("heading", { name: "内容管理" }); expect(requests.find((r) => r.method === "DELETE")?.body).toEqual({ version: 3 });
  expect(screen.getByRole("status")).toHaveTextContent("内容及其媒体文件已删除");
});

it("does not permit deletion when the fresh hierarchy cannot be loaded", async () => {
  let reads = 0;
  const requests = fixture(detail(), (r) => r.url === base && r.method === "GET" && ++reads > 1 ? json({ error: "unavailable" }, 503) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await user.click(screen.getByRole("button", { name: "永久删除剧集" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
});

it("stops publication if an upload's authoritative parent version differs", async () => {
  let reads = 0; const requests = fixture(detail(), (r) => r.url === base && r.method === "GET" && ++reads > 1 ? json(detail({ version: 99 })) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.upload(screen.getByLabelText("视频文件"), new File(["v"], "v.mp4", { type: "video/mp4" })); await user.click(screen.getByRole("button", { name: "发布单集" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/刷新/); expect(requests.some((r) => r.url.endsWith("/publish"))).toBe(false);
});

it("does not continue an upload chain after the editor is unmounted", async () => {
  const pending = deferred<Response>(); const requests = fixture(detail(), (r) => r.method === "PATCH" ? pending.promise : undefined);
  const user = userEvent.setup(); const view = editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.upload(screen.getByLabelText("视频文件"), new File(["v"], "v.mp4", { type: "video/mp4" })); await user.click(screen.getByRole("button", { name: "保存单集草稿" })); view.unmount();
  await act(async () => pending.resolve(json({ series_version: 4, episode: episode({ version: 3 }) })));
  expect(requests.some((r) => r.url.includes("/media/"))).toBe(false);
});

// A publish validation failure must not turn a successful atomic upload into a pending replacement.
it("retains the saved video and retries only publication after a validation failure", async () => {
  const requests = fixture(detail(), (r) => r.url.endsWith("/publish") ? json({ error: "validation", fields: ["video"] }, 422) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("剧集名称");
  await expandFirst(user);
  await user.upload(screen.getByLabelText("视频文件"), new File(["v"], "ready.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "发布单集" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("可播放视频");
  expect(screen.getByRole("link", { name: /已保存视频/ })).toHaveTextContent("ready.mp4");
  expect(screen.queryByText(/待上传：ready/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "发布单集" })); await screen.findByRole("alert");
  expect(requests.filter((r) => r.url.includes("/media/"))).toHaveLength(1);
});
