import { expect, type APIRequestContext, type Playwright } from "@playwright/test";
import type { JsonObject, JsonValue } from "@movie-harbor/api-client";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080";
export const adminName = process.env.E2E_ADMIN_NAME ?? "task15-admin";
export const initialPassword = process.env.E2E_ADMIN_PASSWORD ?? "task15-initial-password";
export const changedPassword = process.env.E2E_CHANGED_PASSWORD ?? "task15-changed-password";
const generated = process.env.E2E_RUN_DIR;
if (!generated || !isAbsolute(generated)) throw new Error("E2E_RUN_DIR must be the runner's absolute isolated directory");
const statePath = resolve(generated, "state.json");
const configuredMediaHostDir = process.env.MEDIA_HOST_DIR;
if (!configuredMediaHostDir || !isAbsolute(configuredMediaHostDir)) throw new Error("MEDIA_HOST_DIR must be the runner's absolute isolated media directory");
const configuredDatabaseHostDir = process.env.DATABASE_HOST_DIR;
if (!configuredDatabaseHostDir || !isAbsolute(configuredDatabaseHostDir)) throw new Error("DATABASE_HOST_DIR must be the runner's absolute isolated database directory");
export const mediaHostDir = configuredMediaHostDir;

// 拍摄媒体目录中文件的快照，供上传或删除前后比较物理文件。
export function snapshotMediaFiles(directory = mediaHostDir): Set<string> {
  const files = new Set<string>();
  // 递归遍历非隐藏目录并记录普通文件，供媒体快照使用。
  function visit(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && lstatSync(child).isFile()) files.add(child);
    }
  }
  // 递归遍历非隐藏目录并记录普通文件，供媒体快照使用。
  visit(directory);
  return files;
}

// 与操作前快照比较，找出测试中新上传的媒体文件。
export function uploadedSince(before: Set<string>): string[] {
  return [...snapshotMediaFiles()].filter((path) => !before.has(path));
}

export const poster = {
  name: "poster.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
};

// 读取运行器生成的短视频，供上传和播放测试使用。
export function video() {
  return { name: "sample.mp4", mimeType: "video/mp4", buffer: readFileSync(resolve(generated, "sample.mp4")) };
}

// 描述管理 API 返回的媒体地址和容器路径，供媒体断言使用。
export type MediaSummary = { url: string; local_path: string };
// 描述题材响应字段，供题材与内容关联测试使用。
export type Genre = { id: string; name: string; sort_order: number; enabled: boolean };
// 描述电影响应及版本、状态和媒体，供管理测试使用。
export type Movie = { id: string; version: number; name: string; status: string; is_private: boolean; poster: MediaSummary | null; video: MediaSummary | null };
// 描述单集响应及版本、状态和视频，供剧集测试使用。
export type Episode = { id: string; version: number; number: number; name: string; status: string; video: MediaSummary | null };
// 描述剧集及其季、单集，供层级和发布测试使用。
export type Series = { id: string; version: number; name: string; status: string; is_private: boolean; poster: MediaSummary | null; seasons: Array<{ id: string; number: number; episodes: Episode[] }> };
// 描述普通用户的标识与版本，供账号测试使用。
export type ViewerUser = { id: string; username: string; version: number };

// 封装管理员认证请求，供创建数据和管理操作测试使用。
export class AdminApi {
  // 保存请求上下文及 CSRF 令牌，供后续已认证请求使用。
  constructor(readonly request: APIRequestContext, readonly csrf: string) {}

  // 创建独立会话并登录，读取 CSRF 令牌后供测试执行已认证请求。
  static async login(playwright: Playwright, password = initialPassword) {
    const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const login = await request.post("/api/admin/login", { data: { name: adminName, password } });
    expect(login.status()).toBe(200);
    const session = await request.get("/api/admin/session");
    expect(session.status()).toBe(200);
    const body = await session.json() as { csrf_token: string };
    return new AdminApi(request, body.csrf_token);
  }

  // 测试结束时释放请求上下文和关联资源。
  async dispose() { await this.request.dispose(); }
  // 创建普通用户，供可见性和账号管理测试使用。
  createUser(username: string, password = "viewer-initial-password") { return this.write<ViewerUser>("post", "/api/admin/users", { username, password }); }
  // 使用当前版本修改普通用户密码，供会话撤销测试使用。
  changeUserPassword(user: ViewerUser, password: string) { return this.write<ViewerUser>("put", `/api/admin/users/${user.id}/password`, { version: user.version, new_password: password }); }
  // 使用当前版本删除普通用户，供账号生命周期测试使用。
  deleteUser(user: ViewerUser) { return this.write<void>("delete", `/api/admin/users/${user.id}`, { version: user.version }); }
  // 使用当前版本更新内容可见性，供公开与私密访问测试使用。
  setPrivacy<T extends Movie | Series>(kind: "movies" | "series", content: T, isPrivate: boolean) {
    return this.write<T>("put", `/api/admin/${kind}/${content.id}/privacy`, { version: content.version, is_private: isPrivate });
  }
  // 为管理写请求提供来源和 CSRF 令牌，供状态变更和上传使用。
  private headers() { return { "X-CSRF-Token": this.csrf, Origin: baseURL }; }
  // 读取管理 API 并断言成功，供获取最新内容和版本使用。
  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  // 发送管理写请求并断言成功，供测试创建或修改内容使用。
  async write<T>(method: "post" | "patch" | "put" | "delete", path: string, data?: JsonObject): Promise<T> {
    const response = await this.request[method](path, { data, headers: this.headers() });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.status() === 204 ? undefined as T : response.json();
  }
  // 通过 multipart 上传测试媒体并断言成功，供媒体生命周期测试使用。
  async upload<T>(path: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<T> {
    const response = await this.request.post(path, { multipart: { file }, headers: this.headers() });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
}

// 封装普通用户认证请求，供私密访问和账号测试使用。
export class ViewerApi {
  // 保存请求上下文及 CSRF 令牌，供后续已认证请求使用。
  constructor(readonly request: APIRequestContext, readonly csrf: string) {}
  // 创建独立会话并登录，读取 CSRF 令牌后供测试执行已认证请求。
  static async login(playwright: Playwright, username: string, password = "viewer-initial-password") {
    const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const response = await request.post("/api/viewer/login", { data: { username, password } });
    expect(response.status(), await response.text()).toBe(200);
    const session = await request.get("/api/viewer/session");
    expect(session.status()).toBe(200);
    expect((await request.storageState()).cookies.some((cookie) => cookie.name === "mh_viewer_session" && cookie.path === "/" && cookie.httpOnly)).toBe(true);
    return new ViewerApi(request, (await session.json()).csrf_token);
  }
  // 以普通用户会话提交改密请求，供验证账号与会话行为使用。
  async changePassword(currentPassword: string, newPassword: string) {
    return this.request.patch("/api/viewer/password", { data: { current_password: currentPassword, new_password: newPassword }, headers: { "X-CSRF-Token": this.csrf } });
  }
  // 测试结束时释放请求上下文和关联资源。
  async dispose() { await this.request.dispose(); }
}

// 创建电影草稿并填写元数据、上传媒体，供发布与编辑场景准备数据。
export async function createMovieDraftWithMedia(api: AdminApi, name: string, options: {
  synopsis: string; durationSeconds: number; includePoster?: boolean; year?: number | null; genreIds?: string[];
}) {
  // 先取得草稿标识与版本，再更新必填元数据；任一步失败都会阻止后续媒体上传。
  let movie = await api.write<Movie>("post", "/api/admin/movies", { name, is_private: false });
  movie = await api.write<Movie>("patch", `/api/admin/movies/${movie.id}`, {
    version: movie.version, name, synopsis: options.synopsis, year: options.year === undefined ? 2026 : options.year,
    duration_seconds: options.durationSeconds, genre_ids: options.genreIds ?? [],
  });
  let version = movie.version;
  if (options.includePoster !== false) {
    // 海报替换会递增电影版本，必须把返回版本交给随后的视频上传，避免过期版本冲突。
    const uploaded = await api.upload<{ version: number }>(`/api/admin/media/movies/${movie.id}/poster?version=${version}`, poster);
    version = uploaded.version;
  }
  await api.upload(`/api/admin/media/movies/${movie.id}/video?version=${version}`, video());
  // 上传响应只提供媒体结果，重新读取详情让调用方获得可用于发布的最新版本和完整字段。
  return api.get<Movie>(`/api/admin/movies/${movie.id}`);
}

// 创建包含媒体的电影并发布，供公开浏览和播放测试使用。
export async function createPublishableMovie(api: AdminApi, name: string) {
  const movie = await createMovieDraftWithMedia(api, name, { synopsis: `${name} searchable synopsis`, durationSeconds: 1 });
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: movie.version });
}

// 创建无海报的已发布电影，供占位和分页测试使用。
export async function createPublishableMovieWithoutPoster(api: AdminApi, name: string) {
  const movie = await createMovieDraftWithMedia(api, name, {
    synopsis: `${name} pagination fixture`, durationSeconds: 1, includePoster: false,
  });
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: movie.version });
}

// 创建剧集、季和单集并上传媒体，供层级与发布场景准备数据。
export async function createSeriesDraftWithMedia(api: AdminApi, name: string, options: {
  synopsis: string; seasonNumber: number; episodeNumber: number; episodeName: string; durationSeconds: number;
  year?: number | null; genreIds?: string[];
}) {
  // 按父级到子级顺序创建测试层级；每次写入沿用最新响应版本，失败立即终止后续步骤。
  let series = await api.write<Series>("post", "/api/admin/series", { name, is_private: false });
  series = await api.write<Series>("patch", `/api/admin/series/${series.id}`, {
    version: series.version, synopsis: options.synopsis, year: options.year ?? null, genre_ids: options.genreIds ?? [],
  });
  const uploaded = await api.upload<{ version: number }>(`/api/admin/media/series/${series.id}/poster?version=${series.version}`, poster);
  // 海报上传更新父级版本，创建季必须使用上传结果而非原剧集版本。
  series = await api.write<Series>("post", `/api/admin/series/${series.id}/seasons`, { version: uploaded.version, number: options.seasonNumber });
  const season = series.seasons.find((item) => item.number === options.seasonNumber)!;
  const episodesPath = `/api/admin/series/${series.id}/seasons/${season.id}/episodes`;
  series = await api.write<Series>("post", episodesPath, { version: series.version, number: options.episodeNumber, name: options.episodeName });
  const episode = series.seasons.find((item) => item.id === season.id)!.episodes[0];
  const updated = await api.write<{ episode: Episode }>("patch", `${episodesPath}/${episode.id}`, {
    version: episode.version, duration_seconds: options.durationSeconds,
  });
  // 时长更新后用最新单集版本上传视频，再读取整剧详情供后续发布或归档测试使用。
  await api.upload(`/api/admin/media/episodes/${episode.id}/video?version=${updated.episode.version}`, video());
  return api.get<Series>(`/api/admin/series/${series.id}`);
}

// 依次发布单集和剧集，供公开浏览与播放测试使用。
export async function createPublishableSeries(api: AdminApi, name: string) {
  let series = await createSeriesDraftWithMedia(api, name, {
    synopsis: `${name} searchable synopsis`,
    seasonNumber: 1,
    episodeNumber: 1,
    episodeName: "首集",
    durationSeconds: 1,
  });
  const season = series.seasons[0]!;
  const episode = season.episodes[0]!;
  // 先发布具备媒体的单集以满足整剧发布前提；响应提供随后整剧发布所需的父级版本。
  const published = await api.write<{ series_version: number }>(
    "post",
    `/api/admin/series/${series.id}/seasons/${season.id}/episodes/${episode.id}/publish`,
    { version: episode.version },
  );
  series = await api.write<Series>("post", `/api/admin/series/${series.id}/publish`, {
    version: published.series_version,
  });
  return series;
}

// 将跨阶段测试状态写入隔离目录，供重启后的持久性测试读取。
export function saveState(state: Record<string, JsonValue>) { writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 }); }
// 读取前一阶段保存的状态，供服务重启后核对数据。
export function loadState<T>() { return JSON.parse(readFileSync(statePath, "utf8")) as T; }
