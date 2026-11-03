import { ApiError, apiDownload, apiPath, apiRequest, apiUpload, clearCsrfToken, requiredResponse, setCsrfToken, type ApiDownload, type ApiUploadProgress } from "./http";
import { isJsonObject } from "./dataTypes";
import type {
  AdminContentListQuery, AdminContentPage, ChangePasswordRequest, ContentStatus, EpisodeEnvelope, GenreResponse, LoginRequest, LoginResponse,
  ChildDeleteImpactResponse, DeleteImpactResponse, DeleteResultResponse, MediaAssetResponse, MovieResponse, ReorderGenre, SeriesResponse, SessionResponse,
  UpdateEpisodeRequest, UpdateMovieRequest, UpdateSeriesRequest,
  ChangeViewerUserPasswordRequest, CreateMovieRequest, CreateSeriesRequest, CreateViewerUserRequest,
  PrivacyRequest, ViewerUserListQuery, ViewerUserPage, ViewerUserSummary,
} from "./types";

// 管理电影和剧集列表共用的状态及名称筛选条件。
type ListQuery = { status?: ContentStatus; name?: string };
// 管理内容状态转换接口允许的发布、归档及转草稿操作。
type LifecycleAction = "publish" | "archive" | "draft";

// 从 API 错误详情读取稳定错误码，供管理操作处理失败时判断原因。
export function apiErrorCode(error: ApiError): string | undefined {
  if (!isJsonObject(error.details)) return undefined;
  const code = error.details.code;
  return typeof code === "string" ? code : undefined;
}

// 在管理员登录时提交凭据并清除旧令牌，等待会话恢复获取新令牌。
export async function login(input: LoginRequest): Promise<LoginResponse> {
  clearCsrfToken();
  return requiredResponse(await apiRequest<LoginResponse, LoginRequest>("/api/admin/login", { method: "POST", json: input }));
}
// 在管理员会话恢复时读取会话并保存 CSRF 令牌，供后续写请求使用。
export async function getSession(): Promise<SessionResponse> {
  const session = requiredResponse(await apiRequest<SessionResponse>("/api/admin/session"));
  setCsrfToken(session.csrf_token);
  return session;
}
// 退出管理员会话，并在请求结束后清除本地令牌。
export async function logout(): Promise<void> {
  try { await apiRequest("/api/admin/logout", { method: "POST" }); }
  finally { clearCsrfToken(); }
}
// 提交管理员改密请求，成功后清除旧会话令牌。
export async function changePassword(input: ChangePasswordRequest): Promise<void> {
  await apiRequest("/api/admin/password", { method: "POST", json: input });
  clearCsrfToken();
}

// 管理用户列表加载时查询普通用户分页，返回结果或请求错误。
export async function listViewerUsers(query: ViewerUserListQuery = {}): Promise<ViewerUserPage> {
  return requiredResponse(await apiRequest<ViewerUserPage>("/api/admin/users", {
    query: { q: query.q, page: query.page, size: query.size },
  }));
}
// 在管理操作时创建普通用户，将请求结果或失败交给调用方处理。
export async function createViewerUser(input: CreateViewerUserRequest): Promise<ViewerUserSummary> {
  return requiredResponse(await apiRequest<ViewerUserSummary, CreateViewerUserRequest>("/api/admin/users", { method: "POST", json: input }));
}
// 在管理操作时修改普通用户密码，将请求结果或失败交给调用方处理。
export async function changeViewerUserPassword(id: string, input: ChangeViewerUserPasswordRequest): Promise<ViewerUserSummary> {
  return requiredResponse(await apiRequest<ViewerUserSummary, ChangeViewerUserPasswordRequest>(apiPath("admin", "users", id, "password"), { method: "PUT", json: input }));
}
// 在管理操作时删除普通用户，将请求结果或失败交给调用方处理。
export async function deleteViewerUser(id: string, version: number): Promise<void> {
  await apiRequest(apiPath("admin", "users", id), { method: "DELETE", json: { version } });
}

// 管理页面加载题材时查询题材列表，返回结果或请求错误。
export async function listGenres(): Promise<GenreResponse[]> {
  return requiredResponse(await apiRequest<GenreResponse[]>("/api/admin/genres"));
}
// 在管理操作时查询管理内容，将请求结果或失败交给调用方处理。
export async function listAdminContent(query: AdminContentListQuery = {}): Promise<AdminContentPage> {
  const params = { kind: query.kind, status: query.status, privacy: query.privacy, name: query.name, page: query.page };
  return requiredResponse(await apiRequest<AdminContentPage>("/api/admin/contents", { query: params }));
}
// 管理员导出全部内容时下载后端生成的 JSON 文件。
export function downloadAdminContentExport(): Promise<ApiDownload> {
  return apiDownload("/api/admin/contents/export");
}
// 在管理操作时创建题材，将请求结果或失败交给调用方处理。
export async function createGenre(name: string): Promise<GenreResponse> {
  return requiredResponse(await apiRequest<GenreResponse, { name: string }>("/api/admin/genres", { method: "POST", json: { name } }));
}
// 在管理操作时重命名题材，将请求结果或失败交给调用方处理。
export async function renameGenre(id: string, name: string): Promise<GenreResponse> {
  return requiredResponse(await apiRequest<GenreResponse, { name: string }>(apiPath("admin", "genres", id), { method: "PATCH", json: { name } }));
}
// 在管理操作时提交题材排序，返回更新后的列表或请求错误。
export async function reorderGenres(items: ReorderGenre[]): Promise<GenreResponse[]> {
  return requiredResponse(await apiRequest<GenreResponse[], { items: ReorderGenre[] }>("/api/admin/genres/order", { method: "PUT", json: { items } }));
}
// 在管理操作时停用题材，将请求结果或失败交给调用方处理。
export async function deactivateGenre(id: string): Promise<GenreResponse> {
  return requiredResponse(await apiRequest<GenreResponse>(apiPath("admin", "genres", id, "deactivate"), { method: "POST" }));
}
// 在管理操作时删除题材，将请求结果或失败交给调用方处理。
export async function deleteGenre(id: string): Promise<void> {
  await apiRequest(apiPath("admin", "genres", id), { method: "DELETE" });
}

// 管理页面加载电影列表时按条件查询，返回结果或请求错误。
export async function listMovies(query: ListQuery = {}): Promise<MovieResponse[]> {
  return requiredResponse(await apiRequest<MovieResponse[]>("/api/admin/movies", { query }));
}
// 在管理操作时创建电影，将请求结果或失败交给调用方处理。
export async function createMovie(name: string, isPrivate: boolean): Promise<MovieResponse> {
  return requiredResponse(await apiRequest<MovieResponse, CreateMovieRequest>("/api/admin/movies", { method: "POST", json: { name, is_private: isPrivate } }));
}
// 在管理操作时设置电影访问范围，将请求结果或失败交给调用方处理。
export async function setMoviePrivacy(id: string, version: number, isPrivate: boolean): Promise<MovieResponse> {
  return requiredResponse(await apiRequest<MovieResponse, PrivacyRequest>(apiPath("admin", "movies", id, "privacy"), { method: "PUT", json: { version, is_private: isPrivate } }));
}
// 在管理操作时读取电影，将请求结果或失败交给调用方处理。
export async function getMovie(id: string): Promise<MovieResponse> {
  return requiredResponse(await apiRequest<MovieResponse>(apiPath("admin", "movies", id)));
}
// 在管理操作时更新电影，将请求结果或失败交给调用方处理。
export async function updateMovie(id: string, input: UpdateMovieRequest): Promise<MovieResponse> {
  return requiredResponse(await apiRequest<MovieResponse, UpdateMovieRequest>(apiPath("admin", "movies", id), { method: "PATCH", json: input }));
}
// 管理员切换电影生命周期时提交操作和版本，返回更新结果或错误。
export async function transitionMovie(id: string, action: LifecycleAction, version: number): Promise<MovieResponse> {
  return requiredResponse(await apiRequest<MovieResponse, { version: number }>(apiPath("admin", "movies", id, action), { method: "POST", json: { version } }));
}
// 在管理操作时读取电影删除影响，将请求结果或失败交给调用方处理。
export async function getMovieDeleteImpact(id: string): Promise<DeleteImpactResponse> {
  return requiredResponse(await apiRequest<DeleteImpactResponse>(apiPath("admin", "movies", id, "delete-impact")));
}
// 在管理操作时删除电影，将请求结果或失败交给调用方处理。
export async function deleteMovie(id: string, version: number): Promise<DeleteResultResponse> {
  return requiredResponse(await apiRequest<DeleteResultResponse, { version: number }>(apiPath("admin", "movies", id), { method: "DELETE", json: { version } }));
}

// 在管理操作时查询剧集，将请求结果或失败交给调用方处理。
export async function listSeries(query: ListQuery = {}): Promise<SeriesResponse[]> {
  return requiredResponse(await apiRequest<SeriesResponse[]>("/api/admin/series", { query }));
}
// 在管理操作时创建剧集，将请求结果或失败交给调用方处理。
export async function createSeries(name: string, isPrivate: boolean): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, CreateSeriesRequest>("/api/admin/series", { method: "POST", json: { name, is_private: isPrivate } }));
}
// 在管理操作时设置剧集访问范围，将请求结果或失败交给调用方处理。
export async function setSeriesPrivacy(id: string, version: number, isPrivate: boolean): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, PrivacyRequest>(apiPath("admin", "series", id, "privacy"), { method: "PUT", json: { version, is_private: isPrivate } }));
}
// 在管理操作时读取剧集，将请求结果或失败交给调用方处理。
export async function getSeries(id: string): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse>(apiPath("admin", "series", id)));
}
// 在管理操作时更新剧集，将请求结果或失败交给调用方处理。
export async function updateSeries(id: string, input: UpdateSeriesRequest): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, UpdateSeriesRequest>(apiPath("admin", "series", id), { method: "PATCH", json: input }));
}
// 管理员切换剧集生命周期时提交操作和版本，返回更新结果或错误。
export async function transitionSeries(id: string, action: LifecycleAction, version: number): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, { version: number }>(apiPath("admin", "series", id, action), { method: "POST", json: { version } }));
}
// 在管理操作时读取剧集删除影响，将请求结果或失败交给调用方处理。
export async function getSeriesDeleteImpact(id: string): Promise<DeleteImpactResponse> {
  return requiredResponse(await apiRequest<DeleteImpactResponse>(apiPath("admin", "series", id, "delete-impact")));
}
// 在管理操作时删除剧集，将请求结果或失败交给调用方处理。
export async function deleteSeries(id: string, version: number): Promise<DeleteResultResponse> {
  return requiredResponse(await apiRequest<DeleteResultResponse, { version: number }>(apiPath("admin", "series", id), { method: "DELETE", json: { version } }));
}

// 在管理操作时创建季，将请求结果或失败交给调用方处理。
export async function createSeason(seriesId: string, number: number, version: number): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, { number: number; version: number }>(apiPath("admin", "series", seriesId, "seasons"), { method: "POST", json: { number, version } }));
}
// 在管理操作时更新季，将请求结果或失败交给调用方处理。
export async function updateSeason(seriesId: string, seasonId: string, number: number, version: number): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, { number: number; version: number }>(apiPath("admin", "series", seriesId, "seasons", seasonId), { method: "PATCH", json: { number, version } }));
}
// 在管理操作时删除季，将请求结果或失败交给调用方处理。
export async function deleteSeason(seriesId: string, seasonId: string, version: number): Promise<DeleteResultResponse> {
  return requiredResponse(await apiRequest<DeleteResultResponse, { version: number }>(apiPath("admin", "series", seriesId, "seasons", seasonId), { method: "DELETE", json: { version } }));
}
// 在管理操作时读取季删除影响，将请求结果或失败交给调用方处理。
export async function getSeasonDeleteImpact(seriesId: string, seasonId: string): Promise<ChildDeleteImpactResponse> {
  return requiredResponse(await apiRequest<ChildDeleteImpactResponse>(apiPath("admin", "series", seriesId, "seasons", seasonId, "delete-impact")));
}
// 在管理操作时创建单集，将请求结果或失败交给调用方处理。
export async function createEpisode(seriesId: string, seasonId: string, input: { version: number; number: number; name: string }): Promise<SeriesResponse> {
  return requiredResponse(await apiRequest<SeriesResponse, { version: number; number: number; name: string }>(apiPath("admin", "series", seriesId, "seasons", seasonId, "episodes"), { method: "POST", json: input }));
}
// 构造单集管理接口路径，供读取、修改和删除操作复用。
function episodePath(seriesId: string, seasonId: string, episodeId: string): string {
  return apiPath("admin", "series", seriesId, "seasons", seasonId, "episodes", episodeId);
}
// 在管理操作时读取单集，将请求结果或失败交给调用方处理。
export async function getEpisode(seriesId: string, seasonId: string, episodeId: string): Promise<EpisodeEnvelope> {
  return requiredResponse(await apiRequest<EpisodeEnvelope>(episodePath(seriesId, seasonId, episodeId)));
}
// 在管理操作时更新单集，将请求结果或失败交给调用方处理。
export async function updateEpisode(seriesId: string, seasonId: string, episodeId: string, input: UpdateEpisodeRequest): Promise<EpisodeEnvelope> {
  return requiredResponse(await apiRequest<EpisodeEnvelope, UpdateEpisodeRequest>(episodePath(seriesId, seasonId, episodeId), { method: "PATCH", json: input }));
}
// 管理员切换单集生命周期时提交操作和版本，返回更新结果或错误。
export async function transitionEpisode(seriesId: string, seasonId: string, episodeId: string, action: LifecycleAction, version: number): Promise<EpisodeEnvelope> {
  return requiredResponse(await apiRequest<EpisodeEnvelope, { version: number }>(`${episodePath(seriesId, seasonId, episodeId)}/${action}`, { method: "POST", json: { version } }));
}
// 在管理操作时删除单集，将请求结果或失败交给调用方处理。
export async function deleteEpisode(seriesId: string, seasonId: string, episodeId: string, version: number): Promise<DeleteResultResponse> {
  return requiredResponse(await apiRequest<DeleteResultResponse, { version: number }>(episodePath(seriesId, seasonId, episodeId), { method: "DELETE", json: { version } }));
}
// 在管理操作时读取单集删除影响，将请求结果或失败交给调用方处理。
export async function getEpisodeDeleteImpact(seriesId: string, seasonId: string, episodeId: string): Promise<ChildDeleteImpactResponse> {
  return requiredResponse(await apiRequest<ChildDeleteImpactResponse>(`${episodePath(seriesId, seasonId, episodeId)}/delete-impact`));
}

// 管理媒体上传目标及其允许的槽位，区分电影、剧集和单集。
type MediaUploadTarget =
  | { kind: "movies"; id: string; slot: "poster" | "video" }
  | { kind: "series"; id: string; slot: "poster" }
  | { kind: "episodes"; id: string; slot: "video" };

// 在管理操作时上传媒体，将请求结果或失败交给调用方处理。
export async function uploadMedia(
  target: MediaUploadTarget,
  file: File,
  version: number,
  onProgress?: (progress: ApiUploadProgress) => void,
): Promise<MediaAssetResponse> {
  const form = new FormData();
  form.append("file", file);
  const path = apiPath("admin", "media", target.kind, target.id, target.slot);
  // 只有需要进度反馈时使用 XHR；否则走普通请求，两条路径都将结果交给调用方。
  const response = onProgress
    ? await apiUpload<MediaAssetResponse>(path, { method: "POST", query: { version }, body: form, onProgress })
    : await apiRequest<MediaAssetResponse>(path, { method: "POST", query: { version }, body: form });
  return requiredResponse(response);
}
