export type ContentKind = "movie" | "series";
export type CatalogKind = "all" | ContentKind;
export type ContentStatus = "draft" | "published" | "archived";

export interface PublicGenre { id: string; name: string }
export interface CatalogCard {
  is_private: boolean;
  id: string; kind: ContentKind; name: string; year: number | null; poster_url: string | null;
  published_at: string; genres: PublicGenre[]; genre_count: number;
}
export interface CatalogPage { page: number; size: number; total: number; items: CatalogCard[] }
export interface AdminContentListItem {
  is_private: boolean;
  id: string;
  kind: ContentKind;
  name: string;
  status: ContentStatus;
  version: number;
  created_at: string;
  poster_url: string | null;
}
export interface AdminContentPage {
  page: number;
  size: number;
  total: number;
  items: AdminContentListItem[];
}
export interface AdminContentListQuery {
  privacy?: "public" | "private";
  kind?: CatalogKind;
  status?: ContentStatus;
  name?: string;
  page?: number;
}
export interface MovieDetail {
  is_private: boolean;
  id: string; kind: "movie"; name: string; synopsis: string; year: number | null;
  duration_seconds: number | null; poster_url: string | null; video_url: string | null; genres: PublicGenre[];
}
export interface PublicEpisode {
  id: string; number: number; name: string; duration_seconds: number | null; video_url: string | null;
}
export interface PublicSeason { id: string; number: number; episodes: PublicEpisode[] }
export interface SeriesDetail {
  is_private: boolean;
  id: string; kind: "series"; name: string; synopsis: string; year: number | null;
  poster_url: string | null; genres: PublicGenre[]; seasons: PublicSeason[];
}

export interface LoginRequest { name: string; password: string }
export interface LoginResponse { name: string }
export interface SessionResponse { name: string; csrf_token: string }
export interface ChangePasswordRequest { current_password: string; new_password: string }
export interface ViewerLoginRequest { username: string; password: string }
export interface ViewerLoginResponse { username: string }
export interface ViewerSessionResponse { username: string; csrf_token: string }
export interface ViewerUserSummary {
  id: string; username: string; version: number; created_at: string;
  last_login_at: string | null; has_active_session: boolean;
}
export interface ViewerUserOverview {
  total_users: number; active_users: number; latest_user: ViewerUserSummary | null;
}
export interface ViewerUserPage {
  page: number; size: number; total: number; items: ViewerUserSummary[]; summary: ViewerUserOverview;
}
export interface ViewerUserListQuery { q?: string; page?: number; size?: 20 }
export interface CreateViewerUserRequest { username: string; password: string }
export interface ChangeViewerUserPasswordRequest { version: number; new_password: string }
export interface CreateGenreRequest { name: string }
export interface UpdateGenreRequest { name: string }
export interface GenreResponse { id: string; name: string; sort_order: number; enabled: boolean }
export interface ReorderGenre { id: string; sort_order: number }
export interface ReorderGenresRequest { items: ReorderGenre[] }
export interface GenreSummary { id: string; name: string; enabled: boolean }
export interface MediaSummary {
  id: string; url: string; local_path: string; original_name: string; mime_type: string; byte_size: number;
}
export interface MovieResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; genres: GenreSummary[]; poster: MediaSummary | null; video: MediaSummary | null;
}
export interface CreateMovieRequest { name: string; is_private: boolean }
export interface MovieListQuery { status?: ContentStatus; name?: string }
export interface VersionRequest { version: number }
export interface PrivacyRequest { version: number; is_private: boolean }
export interface UpdateMovieRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null;
  duration_seconds?: number | null; genre_ids?: string[] | null;
}
export interface EpisodeResponse {
  id: string; season_id: string; number: number; name: string; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; video: MediaSummary | null;
}
export interface SeasonResponse { id: string; number: number; episodes: EpisodeResponse[] }
export interface SeriesResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; status: ContentStatus; version: number;
  published_at: string | null; archived_at: string | null; created_at: string; updated_at: string;
  genres: GenreSummary[]; poster: MediaSummary | null; seasons: SeasonResponse[];
}
export interface CreateSeriesRequest { name: string; is_private: boolean }
export interface SeriesListQuery { status?: ContentStatus; name?: string }
export interface CreateSeasonRequest { version: number; number: number }
export interface UpdateSeasonRequest { version: number; number: number }
export interface CreateEpisodeRequest { version: number; number: number; name: string }
export interface UpdateSeriesRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null; genre_ids?: string[] | null;
}
export interface UpdateEpisodeRequest {
  version: number; number?: number | null; name?: string | null; duration_seconds?: number | null;
}
export interface EpisodeEnvelope { series_version: number; episode: EpisodeResponse }
export interface MediaAssetResponse {
  id: string; original_name: string; mime_type: string; byte_size: number; version: number; series_version?: number;
}
export interface DeleteImpactResponse {
  name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
export interface ChildDeleteImpactResponse {
  display_name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
export interface DeleteResultResponse {
  deleted_media_count: number;
}
