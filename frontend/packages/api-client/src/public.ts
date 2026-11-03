import { apiPath, apiRequest, clearCsrfToken, requiredResponse, setCsrfToken } from "./http";
import type { CatalogKind, CatalogPage, ChangePasswordRequest, MovieDetail, SeriesDetail, ViewerLoginRequest, ViewerLoginResponse, ViewerSessionResponse } from "./types";

// 定义目录查询，供相关请求、状态或组件使用。
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
  // The identity owner must accept a response before it can replace the current CSRF token.
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
