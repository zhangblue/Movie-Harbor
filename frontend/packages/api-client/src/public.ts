import { apiPath, apiRequest, clearCsrfToken, requiredResponse, setCsrfToken } from "./http";
import type {
  CatalogKind, CatalogPage, ChangePasswordRequest, MovieDetail, SeriesDetail,
  ViewerLoginRequest, ViewerLoginResponse, ViewerProgressInput, ViewerProgressKind,
  ViewerProgressMergeRequest, ViewerProgressRemovalKind, ViewerProgressRemovalRequest,
  ViewerProgressSnapshot, ViewerSessionResponse,
} from "./types";

// 公开目录查询支持的内容类别、搜索、私密筛选和分页参数。
export interface CatalogQuery {
  kind?: CatalogKind;
  q?: string;
  privacy?: "private";
  page?: number;
  size?: number;
}

// 登录普通用户并恢复会话，只有调用方接受当前会话时才保留令牌。
export async function viewerLogin(input: ViewerLoginRequest, acceptSession?: (session: ViewerSessionResponse) => boolean): Promise<ViewerLoginResponse> {
  clearCsrfToken();
  const viewer = requiredResponse(await apiRequest<ViewerLoginResponse, ViewerLoginRequest>("/api/viewer/login", { method: "POST", json: input }));
  // 登录响应不含令牌；恢复会话并由身份持有者确认后才能安全发起写请求。
  await getViewerSession(acceptSession);
  return viewer;
}
// 恢复普通用户会话，仅在调用方确认结果仍有效时保存令牌。
export async function getViewerSession(acceptSession: (session: ViewerSessionResponse) => boolean = () => true): Promise<ViewerSessionResponse> {
  const session = requiredResponse(await apiRequest<ViewerSessionResponse>("/api/viewer/session"));
  // 身份持有者确认响应属于当前用户后才写入令牌，避免迟到会话覆盖新身份。
  if (acceptSession(session)) setCsrfToken(session.csrf_token);
  return session;
}
// 退出普通用户会话，并按当前身份检查清除令牌。
export async function viewerLogout(isCurrent: () => boolean = () => true): Promise<void> {
  try { await apiRequest("/api/viewer/logout", { method: "POST" }); }
  finally { if (isCurrent()) clearCsrfToken(); }
}
// 提交普通用户改密请求，并在身份仍有效时清除会话令牌。
export async function changeViewerPassword(input: ChangePasswordRequest, isCurrent: () => boolean = () => true): Promise<void> {
  await apiRequest("/api/viewer/password", { method: "PATCH", json: input });
  if (isCurrent()) clearCsrfToken();
}

// 读取当前普通用户的规范播放进度和剧集游标，供会话恢复时同步。
export async function getViewerProgress(): Promise<ViewerProgressSnapshot> {
  return requiredResponse(await apiRequest<ViewerProgressSnapshot>("/api/viewer/progress"));
}
// 合并本地播放位置、剧集游标和删除墓碑，供登录及离线恢复时调用。
export async function mergeViewerProgress(input: ViewerProgressMergeRequest): Promise<ViewerProgressSnapshot> {
  return requiredResponse(await apiRequest<ViewerProgressSnapshot, ViewerProgressMergeRequest>("/api/viewer/progress/merge", { method: "POST", json: input }));
}
// 写入一条电影或单集播放位置，供播放器暂停、节流保存和结束时调用。
export async function putViewerProgress(kind: ViewerProgressKind, id: string, input: ViewerProgressInput): Promise<ViewerProgressSnapshot> {
  return requiredResponse(await apiRequest<ViewerProgressSnapshot, ViewerProgressInput>(apiPath("viewer", "progress", kind, id), { method: "PUT", json: input }));
}
// 移除电影、单集或整剧进度并保存原始时间，供从头播放和首页移除调用。
export async function removeViewerProgress(kind: ViewerProgressRemovalKind, id: string, input: ViewerProgressRemovalRequest): Promise<ViewerProgressSnapshot> {
  return requiredResponse(await apiRequest<ViewerProgressSnapshot, ViewerProgressRemovalRequest>(apiPath("viewer", "progress", kind, id), { method: "DELETE", json: input }));
}

// 按筛选条件和页码请求公开目录，供目录页加载。
export async function listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  return requiredResponse(await apiRequest<CatalogPage>("/api/catalog", {
    query: { kind: query.kind, q: query.q, privacy: query.privacy, page: query.page, size: query.size },
  }));
}
// 请求公开电影详情，供详情页和播放器加载。
export async function getMovieDetail(id: string): Promise<MovieDetail> {
  return requiredResponse(await apiRequest<MovieDetail>(apiPath("catalog", "movies", id)));
}
// 请求公开剧集详情，供详情页和播放器加载。
export async function getSeriesDetail(id: string): Promise<SeriesDetail> {
  return requiredResponse(await apiRequest<SeriesDetail>(apiPath("catalog", "series", id)));
}
