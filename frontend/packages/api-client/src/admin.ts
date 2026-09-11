import { apiPath, apiRequest, clearCsrfToken, setCsrfToken } from "./http";
import type {
  ChangePasswordRequest, ContentStatus, EpisodeEnvelope, GenreResponse, LoginRequest, LoginResponse,
  MediaAssetResponse, MovieResponse, ReorderGenre, SeriesResponse, SessionResponse,
  UpdateEpisodeRequest, UpdateMovieRequest, UpdateSeriesRequest,
} from "./types";

type ListQuery = { status?: ContentStatus; name?: string };
type LifecycleAction = "publish" | "archive" | "draft";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected an API response body");
  return value;
}

export async function login(input: LoginRequest): Promise<LoginResponse> {
  clearCsrfToken();
  return required(await apiRequest<LoginResponse>("/api/admin/login", { method: "POST", json: input }));
}
export async function getSession(): Promise<SessionResponse> {
  const session = required(await apiRequest<SessionResponse>("/api/admin/session"));
  setCsrfToken(session.csrf_token);
  return session;
}
export async function logout(): Promise<void> {
  try { await apiRequest("/api/admin/logout", { method: "POST" }); }
  finally { clearCsrfToken(); }
}
export async function changePassword(input: ChangePasswordRequest): Promise<void> {
  await apiRequest("/api/admin/password", { method: "POST", json: input });
  clearCsrfToken();
}

export async function listGenres(): Promise<GenreResponse[]> {
  return required(await apiRequest<GenreResponse[]>("/api/admin/genres"));
}
export async function createGenre(name: string): Promise<GenreResponse> {
  return required(await apiRequest<GenreResponse>("/api/admin/genres", { method: "POST", json: { name } }));
}
export async function renameGenre(id: string, name: string): Promise<GenreResponse> {
  return required(await apiRequest<GenreResponse>(apiPath("admin", "genres", id), { method: "PATCH", json: { name } }));
}
export async function reorderGenres(items: ReorderGenre[]): Promise<GenreResponse[]> {
  return required(await apiRequest<GenreResponse[]>("/api/admin/genres/order", { method: "PUT", json: { items } }));
}
export async function deactivateGenre(id: string): Promise<GenreResponse> {
  return required(await apiRequest<GenreResponse>(apiPath("admin", "genres", id, "deactivate"), { method: "POST" }));
}
export async function deleteGenre(id: string): Promise<void> {
  await apiRequest(apiPath("admin", "genres", id), { method: "DELETE" });
}

export async function listMovies(query: ListQuery = {}): Promise<MovieResponse[]> {
  return required(await apiRequest<MovieResponse[]>("/api/admin/movies", { query }));
}
export async function createMovie(name: string): Promise<MovieResponse> {
  return required(await apiRequest<MovieResponse>("/api/admin/movies", { method: "POST", json: { name } }));
}
export async function getMovie(id: string): Promise<MovieResponse> {
  return required(await apiRequest<MovieResponse>(apiPath("admin", "movies", id)));
}
export async function updateMovie(id: string, input: UpdateMovieRequest): Promise<MovieResponse> {
  return required(await apiRequest<MovieResponse>(apiPath("admin", "movies", id), { method: "PATCH", json: input }));
}
export async function associateMovieMedia(id: string, slot: "poster" | "video", assetId: string, version: number): Promise<MovieResponse> {
  return required(await apiRequest<MovieResponse>(apiPath("admin", "movies", id, slot), { method: "PUT", json: { asset_id: assetId, version } }));
}
export async function transitionMovie(id: string, action: LifecycleAction, version: number): Promise<MovieResponse> {
  return required(await apiRequest<MovieResponse>(apiPath("admin", "movies", id, action), { method: "POST", json: { version } }));
}
export async function deleteMovie(id: string, version: number): Promise<void> {
  await apiRequest(apiPath("admin", "movies", id), { method: "DELETE", json: { version } });
}

export async function listSeries(query: ListQuery = {}): Promise<SeriesResponse[]> {
  return required(await apiRequest<SeriesResponse[]>("/api/admin/series", { query }));
}
export async function createSeries(name: string): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>("/api/admin/series", { method: "POST", json: { name } }));
}
export async function getSeries(id: string): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", id)));
}
export async function updateSeries(id: string, input: UpdateSeriesRequest): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", id), { method: "PATCH", json: input }));
}
export async function transitionSeries(id: string, action: LifecycleAction, version: number): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", id, action), { method: "POST", json: { version } }));
}
export async function deleteSeries(id: string, version: number): Promise<void> {
  await apiRequest(apiPath("admin", "series", id), { method: "DELETE", json: { version } });
}

export async function createSeason(seriesId: string, number: number, version: number): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", seriesId, "seasons"), { method: "POST", json: { number, version } }));
}
export async function updateSeason(seriesId: string, seasonId: string, number: number, version: number): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", seriesId, "seasons", seasonId), { method: "PATCH", json: { number, version } }));
}
export async function deleteSeason(seriesId: string, seasonId: string, version: number): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", seriesId, "seasons", seasonId), { method: "DELETE", json: { version } }));
}
export async function createEpisode(seriesId: string, seasonId: string, input: { version: number; number: number; name: string }): Promise<SeriesResponse> {
  return required(await apiRequest<SeriesResponse>(apiPath("admin", "series", seriesId, "seasons", seasonId, "episodes"), { method: "POST", json: input }));
}
function episodePath(seriesId: string, seasonId: string, episodeId: string): string {
  return apiPath("admin", "series", seriesId, "seasons", seasonId, "episodes", episodeId);
}
export async function getEpisode(seriesId: string, seasonId: string, episodeId: string): Promise<EpisodeEnvelope> {
  return required(await apiRequest<EpisodeEnvelope>(episodePath(seriesId, seasonId, episodeId)));
}
export async function updateEpisode(seriesId: string, seasonId: string, episodeId: string, input: UpdateEpisodeRequest): Promise<EpisodeEnvelope> {
  return required(await apiRequest<EpisodeEnvelope>(episodePath(seriesId, seasonId, episodeId), { method: "PATCH", json: input }));
}
export async function transitionEpisode(seriesId: string, seasonId: string, episodeId: string, action: LifecycleAction, version: number): Promise<EpisodeEnvelope> {
  return required(await apiRequest<EpisodeEnvelope>(`${episodePath(seriesId, seasonId, episodeId)}/${action}`, { method: "POST", json: { version } }));
}
export async function deleteEpisode(seriesId: string, seasonId: string, episodeId: string, version: number): Promise<void> {
  await apiRequest(episodePath(seriesId, seasonId, episodeId), { method: "DELETE", json: { version } });
}

type MediaUploadTarget =
  | { kind: "movies"; id: string; slot: "poster" | "video" }
  | { kind: "series"; id: string; slot: "poster" }
  | { kind: "episodes"; id: string; slot: "video" };

export async function uploadMedia(target: MediaUploadTarget, file: File, version: number): Promise<MediaAssetResponse> {
  const form = new FormData();
  form.append("file", file);
  return required(await apiRequest<MediaAssetResponse>(apiPath("admin", "media", target.kind, target.id, target.slot), {
    method: "POST", query: { version }, body: form,
  }));
}
