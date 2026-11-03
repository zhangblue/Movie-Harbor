// 定义内容类型，供相关请求、状态或组件使用。
export type ContentKind = "movie" | "series";
// 定义目录类型，供相关请求、状态或组件使用。
export type CatalogKind = "all" | ContentKind;
// 定义内容状态，供相关请求、状态或组件使用。
export type ContentStatus = "draft" | "published" | "archived";

// 定义公开题材，供相关请求、状态或组件使用。
export interface PublicGenre { id: string; name: string }
// 定义目录卡片，供相关请求、状态或组件使用。
export interface CatalogCard {
  is_private: boolean;
  id: string; kind: ContentKind; name: string; year: number | null; poster_url: string | null;
  published_at: string; genres: PublicGenre[]; genre_count: number;
}
// 公开目录请求返回的页码、总数和卡片列表。
export interface CatalogPage { page: number; size: number; total: number; items: CatalogCard[] }
// 定义管理内容列表条目，供相关请求、状态或组件使用。
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
// 定义管理内容分页，供相关请求、状态或组件使用。
export interface AdminContentPage {
  page: number;
  size: number;
  total: number;
  items: AdminContentListItem[];
}
// 定义管理内容列表查询，供相关请求、状态或组件使用。
export interface AdminContentListQuery {
  privacy?: "public" | "private";
  kind?: CatalogKind;
  status?: ContentStatus;
  name?: string;
  page?: number;
}
// 定义电影详情，供相关请求、状态或组件使用。
export interface MovieDetail {
  is_private: boolean;
  id: string; kind: "movie"; name: string; synopsis: string; year: number | null;
  duration_seconds: number | null; poster_url: string | null; video_url: string | null; genres: PublicGenre[];
}
// 定义公开单集，供相关请求、状态或组件使用。
export interface PublicEpisode {
  id: string; number: number; name: string; duration_seconds: number | null; video_url: string | null;
}
// 定义公开季，供相关请求、状态或组件使用。
export interface PublicSeason { id: string; number: number; episodes: PublicEpisode[] }
// 定义剧集详情，供相关请求、状态或组件使用。
export interface SeriesDetail {
  is_private: boolean;
  id: string; kind: "series"; name: string; synopsis: string; year: number | null;
  poster_url: string | null; genres: PublicGenre[]; seasons: PublicSeason[];
}

// 定义登录请求，供相关请求、状态或组件使用。
export interface LoginRequest { name: string; password: string }
// 定义登录响应，供相关请求、状态或组件使用。
export interface LoginResponse { name: string }
// 定义会话响应，供相关请求、状态或组件使用。
export interface SessionResponse { name: string; csrf_token: string }
// 定义修改密码请求，供相关请求、状态或组件使用。
export interface ChangePasswordRequest { current_password: string; new_password: string }
// 定义普通用户登录请求，供相关请求、状态或组件使用。
export interface ViewerLoginRequest { username: string; password: string }
// 定义普通用户登录响应，供相关请求、状态或组件使用。
export interface ViewerLoginResponse { username: string }
// 定义普通用户会话响应，供相关请求、状态或组件使用。
export interface ViewerSessionResponse { username: string; csrf_token: string }
// 管理用户列表中单个普通用户的版本和会话摘要。
export interface ViewerUserSummary {
  id: string; username: string; version: number; created_at: string;
  last_login_at: string | null; has_active_session: boolean;
}
// 管理用户列表返回的用户总数、活跃数和最近用户。
export interface ViewerUserOverview {
  total_users: number; active_users: number; latest_user: ViewerUserSummary | null;
}
// 管理用户列表返回的分页数据及用户概览。
export interface ViewerUserPage {
  page: number; size: number; total: number; items: ViewerUserSummary[]; summary: ViewerUserOverview;
}
// 管理用户列表请求支持的搜索词、页码和页大小。
export interface ViewerUserListQuery { q?: string; page?: number; size?: 20 }
// 创建普通用户时提交的用户名和密码。
export interface CreateViewerUserRequest { username: string; password: string }
// 管理员重置普通用户密码时提交的版本和新密码。
export interface ChangeViewerUserPasswordRequest { version: number; new_password: string }
// 定义创建题材请求，供相关请求、状态或组件使用。
export interface CreateGenreRequest { name: string }
// 定义更新题材请求，供相关请求、状态或组件使用。
export interface UpdateGenreRequest { name: string }
// 定义题材响应，供相关请求、状态或组件使用。
export interface GenreResponse { id: string; name: string; sort_order: number; enabled: boolean }
// 定义排序题材，供相关请求、状态或组件使用。
export interface ReorderGenre { id: string; sort_order: number }
// 提交题材排序时使用的条目集合。
export interface ReorderGenresRequest { items: ReorderGenre[] }
// 定义题材摘要，供相关请求、状态或组件使用。
export interface GenreSummary { id: string; name: string; enabled: boolean }
// 定义媒体摘要，供相关请求、状态或组件使用。
export interface MediaSummary {
  id: string; url: string; local_path: string; original_name: string; mime_type: string; byte_size: number;
}
// 定义电影响应，供相关请求、状态或组件使用。
export interface MovieResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; genres: GenreSummary[]; poster: MediaSummary | null; video: MediaSummary | null;
}
// 定义创建电影请求，供相关请求、状态或组件使用。
export interface CreateMovieRequest { name: string; is_private: boolean }
// 定义电影列表查询，供相关请求、状态或组件使用。
export interface MovieListQuery { status?: ContentStatus; name?: string }
// 定义版本请求，供相关请求、状态或组件使用。
export interface VersionRequest { version: number }
// 定义访问范围请求，供相关请求、状态或组件使用。
export interface PrivacyRequest { version: number; is_private: boolean }
// 定义更新电影请求，供相关请求、状态或组件使用。
export interface UpdateMovieRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null;
  duration_seconds?: number | null; genre_ids?: string[] | null;
}
// 定义单集响应，供相关请求、状态或组件使用。
export interface EpisodeResponse {
  id: string; season_id: string; number: number; name: string; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; video: MediaSummary | null;
}
// 定义季响应，供相关请求、状态或组件使用。
export interface SeasonResponse { id: string; number: number; episodes: EpisodeResponse[] }
// 定义剧集响应，供相关请求、状态或组件使用。
export interface SeriesResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; status: ContentStatus; version: number;
  published_at: string | null; archived_at: string | null; created_at: string; updated_at: string;
  genres: GenreSummary[]; poster: MediaSummary | null; seasons: SeasonResponse[];
}
// 定义创建剧集请求，供相关请求、状态或组件使用。
export interface CreateSeriesRequest { name: string; is_private: boolean }
// 定义剧集列表查询，供相关请求、状态或组件使用。
export interface SeriesListQuery { status?: ContentStatus; name?: string }
// 定义创建季请求，供相关请求、状态或组件使用。
export interface CreateSeasonRequest { version: number; number: number }
// 定义更新季请求，供相关请求、状态或组件使用。
export interface UpdateSeasonRequest { version: number; number: number }
// 定义创建单集请求，供相关请求、状态或组件使用。
export interface CreateEpisodeRequest { version: number; number: number; name: string }
// 定义更新剧集请求，供相关请求、状态或组件使用。
export interface UpdateSeriesRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null; genre_ids?: string[] | null;
}
// 定义更新单集请求，供相关请求、状态或组件使用。
export interface UpdateEpisodeRequest {
  version: number; number?: number | null; name?: string | null; duration_seconds?: number | null;
}
// 单集操作返回的单集数据及其所属剧集版本。
export interface EpisodeEnvelope { series_version: number; episode: EpisodeResponse }
// 定义媒体资产响应，供相关请求、状态或组件使用。
export interface MediaAssetResponse {
  id: string; original_name: string; mime_type: string; byte_size: number; version: number; series_version?: number;
}
// 定义删除影响响应，供相关请求、状态或组件使用。
export interface DeleteImpactResponse {
  name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
// 定义子项删除影响响应，供相关请求、状态或组件使用。
export interface ChildDeleteImpactResponse {
  display_name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
// 定义删除结果响应，供相关请求、状态或组件使用。
export interface DeleteResultResponse {
  deleted_media_count: number;
}
