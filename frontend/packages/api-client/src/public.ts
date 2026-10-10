import { apiPath, apiRequest, clearCsrfToken, requiredResponse, setCsrfToken } from "./http";
import type { CatalogKind, CatalogPage, ChangePasswordRequest, MovieDetail, SeriesDetail, ViewerLoginRequest, ViewerLoginResponse, ViewerSessionResponse } from "./types";

export interface CatalogQuery { kind?: CatalogKind; q?: string; page?: number; size?: number }

export async function viewerLogin(input: ViewerLoginRequest): Promise<ViewerLoginResponse> {
  clearCsrfToken();
  const viewer = requiredResponse(await apiRequest<ViewerLoginResponse, ViewerLoginRequest>("/api/viewer/login", { method: "POST", json: input }));
  await getViewerSession();
  return viewer;
}
export async function getViewerSession(): Promise<ViewerSessionResponse> {
  const session = requiredResponse(await apiRequest<ViewerSessionResponse>("/api/viewer/session"));
  setCsrfToken(session.csrf_token);
  return session;
}
export async function viewerLogout(): Promise<void> {
  try { await apiRequest("/api/viewer/logout", { method: "POST" }); }
  finally { clearCsrfToken(); }
}
export async function changeViewerPassword(input: ChangePasswordRequest): Promise<void> {
  await apiRequest("/api/viewer/password", { method: "PATCH", json: input });
  clearCsrfToken();
}

export async function listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  return requiredResponse(await apiRequest<CatalogPage>("/api/catalog", {
    query: { kind: query.kind, q: query.q, page: query.page, size: query.size },
  }));
}
export async function getMovieDetail(id: string): Promise<MovieDetail> {
  return requiredResponse(await apiRequest<MovieDetail>(apiPath("catalog", "movies", id)));
}
export async function getSeriesDetail(id: string): Promise<SeriesDetail> {
  return requiredResponse(await apiRequest<SeriesDetail>(apiPath("catalog", "series", id)));
}
