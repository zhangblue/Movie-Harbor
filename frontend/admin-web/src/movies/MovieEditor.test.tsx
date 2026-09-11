import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCsrfToken, setCsrfToken, type MovieResponse } from "@movie-harbor/api-client";
import { MovieEditor } from "./MovieEditor";
import { App } from "../app/App";
import { deferred, json, movie, session } from "../test/server";
import styles from "../styles.css?raw";

type Request = { url: string; method: string; body: any; headers: Headers };
function fixture(initial: MovieResponse = movie(), intercept?: (r: Request) => Response | Promise<Response> | undefined) {
  let current = initial;
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const r = { url, method: init.method ?? "GET", body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) };
    requests.push(r);
    const response = intercept?.(r);
    if (response) return response;
    if (url === "/api/admin/session") return json(session);
    if (url === "/api/admin/genres") return json([{ id: "g1", name: "剧情", enabled: true, sort_order: 1 }, { id: "g2", name: "旧题材", enabled: false, sort_order: 2 }]);
    if (url === "/api/admin/series") return json([]);
    if (url === "/api/admin/movies" && r.method === "GET") return json([current]);
    if (url === "/api/admin/movies" && r.method === "POST") { current = movie({ name: r.body.name, poster: null, version: 1 }); return json(current, 201); }
    if (url === "/api/admin/movies/movie-1" && r.method === "GET") return json(current);
    if (r.method === "PATCH") {
      current = { ...current, ...r.body, version: current.version + 1, genres: r.body.genre_ids.map((id: string) => ({ id, name: id === "g1" ? "剧情" : "旧题材", enabled: id === "g1" })) };
      return json(current);
    }
    if (url.startsWith("/api/admin/media/")) {
      const slot = url.includes("/poster?") ? "poster" : "video";
      const file = r.body.get("file") as File;
      current = { ...current, version: current.version + 1, [slot]: { id: `new-${slot}`, url: `/media/new-${slot}`, original_name: file.name, mime_type: file.type, byte_size: file.size } };
      return json({ ...current[slot], version: current.version });
    }
    if (r.method === "POST") {
      current = { ...current, version: current.version + 1, status: url.endsWith("archive") ? "archived" : url.endsWith("draft") ? "draft" : "published" };
      return json(current);
    }
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${r.method} ${url}`);
  });
  return requests;
}
beforeEach(() => {
  setCsrfToken("session-csrf");
  let next = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${++next}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); });
function editor(id: string | null = "movie-1") {
  return render(<><style>{styles}</style><MovieEditor movieId={id} onBack={() => {}} onExpired={() => {}} /></>);
}

// Catches absent/oversized fields, lossy duration conversion, and selecting inactive new genres.
it("loads bounded draft fields and retains existing inactive genres", async () => {
  fixture(movie({ genres: [{ id: "g2", name: "旧题材", enabled: false }] }));
  editor();
  expect(await screen.findByLabelText("名称")).toHaveValue("潮汐尽头");
  expect(screen.getByLabelText("时长（分钟）")).toHaveValue(120);
  expect(getComputedStyle(screen.getByLabelText("名称").parentElement!).width).toBe("290px");
  expect(getComputedStyle(screen.getByLabelText("年份").parentElement!).width).toBe("145px");
  expect(screen.getByRole("option", { name: /旧题材/ })).toBeDisabled();
  expect(screen.getByRole("option", { name: /旧题材/ })).toHaveProperty("selected", true);
});

// Catches missing poster click wiring, cancellation clearing preview, and early/leaked object URLs.
it("previews replacement immediately, preserves cancellation, and releases URLs only when unused", async () => {
  fixture(); const user = userEvent.setup(); const view = editor();
  const button = await screen.findByRole("button", { name: "选择或替换海报" });
  const input = screen.getByLabelText("海报文件");
  const clicked = vi.spyOn(input, "click");
  await user.click(button); expect(clicked).toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [] } });
  expect(screen.getByRole("img", { name: "当前海报预览" })).toHaveAttribute("src", "/media/poster.webp");
  await user.upload(input, new File(["one"], "one.png", { type: "image/png" }));
  expect(screen.getByRole("img", { name: "当前海报预览" })).toHaveAttribute("src", "blob:preview-1");
  fireEvent.change(input, { target: { files: [] } });
  fireEvent.load(screen.getByRole("img", { name: "当前海报预览" }));
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await user.upload(input, new File(["two"], "two.png", { type: "image/png" }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:preview-2");
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
});

it("saves fields and genres before atomically uploading poster then video with returned versions", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor();
  await screen.findByLabelText("名称");
  await user.clear(screen.getByLabelText("名称")); await user.type(screen.getByLabelText("名称"), "新电影");
  await user.selectOptions(screen.getByLabelText("题材"), "g1");
  await user.upload(screen.getByLabelText("海报文件"), new File(["poster"], "new.png", { type: "image/png" }));
  await user.upload(screen.getByLabelText("视频文件"), new File(["video"], "new.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存。");
  const writes = requests.filter((r) => r.method !== "GET");
  expect(writes.map((r) => [r.method, r.url])).toEqual([["PATCH", "/api/admin/movies/movie-1"], ["POST", "/api/admin/media/movies/movie-1/poster?version=4"], ["POST", "/api/admin/media/movies/movie-1/video?version=5"]]);
  expect(writes[0].body).toEqual({ version: 3, name: "新电影", synopsis: "海上故事", year: 2026, duration_seconds: 7200, genre_ids: ["g1"] });
  expect(writes[1].body.get("file").name).toBe("new.png");
  expect(writes[2].headers.get("X-CSRF-Token")).toBe("session-csrf");
  expect(screen.getByRole("img", { name: "当前海报预览" })).toHaveAttribute("src", "/media/new-poster");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
});

it("preserves old media and pending selection after upload failure for an explicit retry", async () => {
  let failed = true;
  const requests = fixture(movie(), (r) => r.url.includes("/media/") && failed ? json({ error: "upload interrupted" }, 500) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["pic"], "retry.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/upload interrupted/);
  expect(screen.getByRole("link", { name: /已保存海报/ })).toHaveAttribute("href", "/media/poster.webp");
  expect(screen.getByText(/待上传：retry.png/)).toBeInTheDocument();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  failed = false; await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存。");
  expect(requests.filter((r) => r.url.includes("/media/")).map((r) => r.url)).toEqual(["/api/admin/media/movies/movie-1/poster?version=4", "/api/admin/media/movies/movie-1/poster?version=5"]);
});

it.each(["published", "archived"] as const)("keeps all %s fields and media read-only", async (status) => {
  fixture(movie({ status })); editor(); await screen.findByLabelText("名称");
  for (const label of ["名称", "年份", "时长（分钟）", "简介", "题材"]) expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.queryByLabelText("海报文件")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("视频文件")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存草稿" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "选择或替换海报" })).not.toBeInTheDocument();
});

it("shows structured publish validation without losing the draft", async () => {
  fixture(movie(), (r) => r.url.endsWith("/publish") ? json({ error: "movie validation failed", fields: ["name", "poster", "video"] }, 422) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.click(screen.getByRole("button", { name: "发布" }));
  const errors = await screen.findByRole("alert");
  expect(within(errors).getAllByRole("listitem").map((x) => x.textContent)).toEqual(["名称", "海报", "可播放视频"]);
  expect(screen.getByLabelText("名称")).toBeEnabled();
});

it("reloads authoritative details after publish, archive and return to draft", async () => {
  const requests = fixture(); const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  for (const action of ["发布", "归档", "转为草稿"]) { await user.click(screen.getByRole("button", { name: action })); await waitFor(() => expect(requests.at(-1)?.method).toBe("GET")); }
  await waitFor(() => expect(screen.getByLabelText("名称")).toBeEnabled());
  const transitions = requests.filter((r) => /\/(publish|archive|draft)$/.test(r.url));
  expect(transitions.map((r) => r.body.version)).toEqual([4, 5, 6]);
  for (const r of transitions) expect(requests[requests.indexOf(r) + 1].url).toBe("/api/admin/movies/movie-1");
});

it("creates a named draft first and opens it from the App content entry", async () => {
  const requests = fixture(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: /新建内容/ }));
  await user.type(await screen.findByLabelText("名称"), "新片");
  await user.click(screen.getByRole("button", { name: "创建草稿" }));
  await screen.findByRole("button", { name: "保存草稿" });
  expect(requests.find((r) => r.method === "POST")?.body).toEqual({ name: "新片" });
  await user.click(screen.getByRole("button", { name: "返回列表" }));
  await user.click(within(await screen.findByRole("row", { name: /新片/ })).getByRole("button", { name: "编辑" }));
  expect(await screen.findByLabelText("名称")).toHaveValue("新片");
});

it("locks stale writes after 409 and explicitly refreshes before retrying", async () => {
  let failed = true; const requests = fixture(movie(), (r) => r.method === "PATCH" && failed ? json({ error: "conflict" }, 409) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/刷新/);
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  failed = false; await user.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存草稿" })).toBeEnabled());
});

it.each([401, 403])("handles write %s through session recovery without replay", async (code) => {
  let token = "session-csrf";
  const requests = fixture(movie(), (r) => r.method === "PATCH" ? json({ error: "denied" }, code) : r.url.endsWith("/session") ? json({ ...session, csrf_token: token }) : undefined);
  const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /潮汐/ })).getByRole("button", { name: "编辑" }));
  await screen.findByLabelText("名称"); token = "renewed";
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  if (code === 401) await screen.findByRole("heading", { name: "管理员登录" });
  else { expect(await screen.findByRole("alert")).toHaveTextContent(/重新执行/); await user.click(screen.getByRole("button", { name: "保存草稿" })); await screen.findByRole("alert"); }
  expect(requests.filter((r) => r.method === "PATCH").map((r) => r.headers.get("X-CSRF-Token"))).toEqual(code === 401 ? ["session-csrf"] : ["session-csrf", "renewed"]);
});

it("keeps pending preview alive during save and releases it when a refresh hides it", async () => {
  const pending = deferred<Response>(); const requests = fixture(movie(), (r) => r.method === "PATCH" ? pending.promise : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["p"], "p.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => pending.resolve(json({ error: "conflict" }, 409)));
  await user.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1"));
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});

// Catches deleting based on stale list/detail data, approximate name matching, or skipped impact fetch.
it("fetches fresh deletion scope and requires the exact server name and version", async () => {
  let reads = 0;
  const requests = fixture(movie(), (r) => r.url === "/api/admin/movies/movie-1" && r.method === "GET" && ++reads > 1
    ? json(movie({ name: "最新名称", version: 9, poster: null, video: { id: "v", url: "/media/v", original_name: "v.mp4", mime_type: "video/mp4", byte_size: 1 } })) : undefined);
  const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /潮汐/ })).getByRole("button", { name: "编辑" }));
  await user.click(await screen.findByRole("button", { name: "永久删除" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除电影" }));
  expect(dialog.getByText(/季：0/)).toBeInTheDocument(); expect(dialog.getByText(/单集：0/)).toBeInTheDocument();
  expect(dialog.getByText(/海报：0/)).toBeInTheDocument(); expect(dialog.getByText(/视频：1/)).toBeInTheDocument();
  expect(dialog.getByText(/不可恢复/)).toBeInTheDocument();
  await user.type(dialog.getByLabelText("输入完整内容名称"), "最新名称 ");
  expect(dialog.getByRole("button", { name: "确认永久删除" })).toBeDisabled();
  await user.clear(dialog.getByLabelText("输入完整内容名称")); await user.type(dialog.getByLabelText("输入完整内容名称"), "最新名称");
  await user.click(dialog.getByRole("button", { name: "确认永久删除" }));
  await screen.findByRole("heading", { name: "内容管理" });
  expect(requests.find((r) => r.method === "DELETE")?.body).toEqual({ version: 9 });
});

it("does not permit deletion when the fresh impact detail cannot be loaded", async () => {
  let reads = 0; const requests = fixture(movie(), (r) => r.url === "/api/admin/movies/movie-1" && r.method === "GET" && ++reads > 1 ? json({ error: "unavailable" }, 503) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "确认永久删除" })).not.toBeInTheDocument();
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
});

// A new external edit between upload and GET must not silently become our next write's version.
it("stops the remaining upload when the authoritative detail changed concurrently", async () => {
  let reads = 0;
  const requests = fixture(movie(), (r) => r.url === "/api/admin/movies/movie-1" && r.method === "GET" && ++reads > 1 ? json(movie({ version: 20, name: "另一位编辑修改" })) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["p"], "p.png", { type: "image/png" }));
  await user.upload(screen.getByLabelText("视频文件"), new File(["v"], "v.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/刷新/);
  expect(requests.filter((r) => r.url.includes("/media/")).map((r) => r.url)).toEqual(["/api/admin/media/movies/movie-1/poster?version=4"]);
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
});

it("preserves a successfully saved poster when the following video upload fails", async () => {
  let failed = true;
  const requests = fixture(movie(), (r) => r.url.includes("/video?") && failed ? json({ error: "video interrupted" }, 500) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.upload(screen.getByLabelText("海报文件"), new File(["p"], "p.png", { type: "image/png" }));
  await user.upload(screen.getByLabelText("视频文件"), new File(["v"], "v.mp4", { type: "video/mp4" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("img", { name: "当前海报预览" })).toHaveAttribute("src", "/media/new-poster");
  expect(screen.getByText(/待上传：v.mp4/)).toBeInTheDocument();
  expect(screen.queryByText(/待上传：p.png/)).not.toBeInTheDocument();
  failed = false; await user.click(screen.getByRole("button", { name: "保存草稿" })); await screen.findByText("草稿已保存。");
  expect(requests.filter((r) => r.url.includes("/media/")).map((r) => r.url)).toEqual(["/api/admin/media/movies/movie-1/poster?version=4", "/api/admin/media/movies/movie-1/video?version=5", "/api/admin/media/movies/movie-1/video?version=6"]);
});

it("opens the list deletion entry with a fresh server detail and allows cancel without a write", async () => {
  const requests = fixture(); const user = userEvent.setup(); render(<App />);
  await user.click(within(await screen.findByRole("row", { name: /潮汐/ })).getByRole("button", { name: "永久删除" }));
  const dialog = within(await screen.findByRole("dialog", { name: "永久删除电影" }));
  expect(dialog.getByText("海报：1")).toBeInTheDocument();
  expect(requests.some((r) => r.url === "/api/admin/movies/movie-1" && r.method === "GET")).toBe(true);
  await user.click(dialog.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(requests.some((r) => r.method !== "GET")).toBe(false);
});

it("locks lifecycle actions when a successful transition's detail reload fails", async () => {
  let reads = 0;
  const requests = fixture(movie({ status: "archived" }), (r) => r.url === "/api/admin/movies/movie-1" && r.method === "GET" && ++reads > 1 ? json({ error: "unavailable" }, 503) : undefined);
  const user = userEvent.setup(); editor(); await screen.findByLabelText("名称");
  await user.click(screen.getByRole("button", { name: "原样发布" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "原样发布" })).toBeDisabled();
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});
