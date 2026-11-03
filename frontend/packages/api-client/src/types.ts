// 电影或剧集的内容类别，供公开目录与管理内容响应区分条目。
export type ContentKind = "movie" | "series";
// 目录筛选可选全部、电影或剧集，供公开及管理列表查询。
export type CatalogKind = "all" | ContentKind;
// 草稿、已发布或已归档的生命周期状态，供管理端筛选和操作。
export type ContentStatus = "draft" | "published" | "archived";

// 公开内容的题材标识和名称，不包含管理状态。
export interface PublicGenre { id: string; name: string }
// 公开目录单张卡片所需的访问范围、元数据、海报和题材。
export interface CatalogCard {
  is_private: boolean;
  id: string; kind: ContentKind; name: string; year: number | null; poster_url: string | null;
  published_at: string; genres: PublicGenre[]; genre_count: number;
}
// 公开目录请求返回的页码、总数和卡片列表。
export interface CatalogPage { page: number; size: number; total: number; items: CatalogCard[] }
// 管理统一列表中的内容摘要，包含状态、版本及访问范围。
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
// 管理内容接口返回的分页边界和当前页条目。
export interface AdminContentPage {
  page: number;
  size: number;
  total: number;
  items: AdminContentListItem[];
}
// 管理统一列表支持的访问范围、类别、状态、名称和页码筛选。
export interface AdminContentListQuery {
  privacy?: "public" | "private";
  kind?: CatalogKind;
  status?: ContentStatus;
  name?: string;
  page?: number;
}
// 公开电影详情与可播放媒体 URL，不包含管理媒体路径。
export interface MovieDetail {
  is_private: boolean;
  id: string; kind: "movie"; name: string; synopsis: string; year: number | null;
  duration_seconds: number | null; poster_url: string | null; video_url: string | null; genres: PublicGenre[];
}
// 公开剧集中的单集名称、序号、时长和可选视频 URL。
export interface PublicEpisode {
  id: string; number: number; name: string; duration_seconds: number | null; video_url: string | null;
}
// 公开剧集详情中的季序号及其可见单集。
export interface PublicSeason { id: string; number: number; episodes: PublicEpisode[] }
// 公开剧集详情、访问范围和可见季列表，不包含管理媒体路径。
export interface SeriesDetail {
  is_private: boolean;
  id: string; kind: "series"; name: string; synopsis: string; year: number | null;
  poster_url: string | null; genres: PublicGenre[]; seasons: PublicSeason[];
}

// 管理员登录时提交的账号名称和密码。
export interface LoginRequest { name: string; password: string }
// 管理员登录成功返回的账号名称；会话令牌需另行获取。
export interface LoginResponse { name: string }
// 管理员会话恢复返回的账号名称和 CSRF 令牌。
export interface SessionResponse { name: string; csrf_token: string }
// 管理员及普通用户修改本人密码时提交的当前密码和新密码。
export interface ChangePasswordRequest { current_password: string; new_password: string }
// 普通用户独立登录接口使用的用户名与密码。
export interface ViewerLoginRequest { username: string; password: string }
// 普通用户登录成功返回的用户名；会话令牌需另行获取。
export interface ViewerLoginResponse { username: string }
// 普通用户会话恢复返回的用户名和 CSRF 令牌。
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
// 管理端创建题材时提交的名称。
export interface CreateGenreRequest { name: string }
// 管理端重命名题材时提交的新名称。
export interface UpdateGenreRequest { name: string }
// 管理题材列表返回的标识、排序和启用状态。
export interface GenreResponse { id: string; name: string; sort_order: number; enabled: boolean }
// 管理端提交题材排序时的一项标识和目标顺序。
export interface ReorderGenre { id: string; sort_order: number }
// 提交题材排序时使用的条目集合。
export interface ReorderGenresRequest { items: ReorderGenre[] }
// 管理内容详情中的题材标识、名称和启用状态。
export interface GenreSummary { id: string; name: string; enabled: boolean }
// 管理内容详情中的媒体元数据；local_path 为受控存储派生的容器路径，不属于公开 API。
export interface MediaSummary {
  id: string; url: string; local_path: string; original_name: string; mime_type: string; byte_size: number;
}
// 管理电影详情，含生命周期、版本、题材与管理媒体摘要。
export interface MovieResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; genres: GenreSummary[]; poster: MediaSummary | null; video: MediaSummary | null;
}
// 管理端创建电影时提交名称及初始访问范围。
export interface CreateMovieRequest { name: string; is_private: boolean }
// 管理电影列表按状态和名称筛选的可选条件。
export interface MovieListQuery { status?: ContentStatus; name?: string }
// 管理写操作使用的乐观并发版本。
export interface VersionRequest { version: number }
// 管理端切换内容访问范围时提交的版本和私密标记。
export interface PrivacyRequest { version: number; is_private: boolean }
// 管理端修改草稿电影时提交版本及可选字段，空值用于显式清除。
export interface UpdateMovieRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null;
  duration_seconds?: number | null; genre_ids?: string[] | null;
}
// 管理单集详情，含生命周期、版本和视频媒体摘要。
export interface EpisodeResponse {
  id: string; season_id: string; number: number; name: string; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; video: MediaSummary | null;
}
// 管理剧集中的季标识、序号及完整单集响应。
export interface SeasonResponse { id: string; number: number; episodes: EpisodeResponse[] }
// 管理剧集详情，含生命周期、版本、海报、题材及季列表。
export interface SeriesResponse {
  is_private: boolean;
  id: string; name: string; synopsis: string; year: number | null; status: ContentStatus; version: number;
  published_at: string | null; archived_at: string | null; created_at: string; updated_at: string;
  genres: GenreSummary[]; poster: MediaSummary | null; seasons: SeasonResponse[];
}
// 管理端创建剧集时提交名称及初始访问范围。
export interface CreateSeriesRequest { name: string; is_private: boolean }
// 管理剧集列表按状态和名称筛选的可选条件。
export interface SeriesListQuery { status?: ContentStatus; name?: string }
// 管理端新增季时提交所属剧集版本和季序号。
export interface CreateSeasonRequest { version: number; number: number }
// 管理端修改季序号时提交所属剧集版本和新序号。
export interface UpdateSeasonRequest { version: number; number: number }
// 管理端新增单集时提交剧集版本、集序号和管理员输入的名称。
export interface CreateEpisodeRequest { version: number; number: number; name: string }
// 管理端修改草稿剧集时提交版本及可选内容字段。
export interface UpdateSeriesRequest {
  version: number; name?: string | null; synopsis?: string | null; year?: number | null; genre_ids?: string[] | null;
}
// 管理端修改草稿单集时提交版本及可选序号、名称和时长。
export interface UpdateEpisodeRequest {
  version: number; number?: number | null; name?: string | null; duration_seconds?: number | null;
}
// 单集操作返回的单集数据及其所属剧集版本。
export interface EpisodeEnvelope { series_version: number; episode: EpisodeResponse }
// 管理媒体上传成功返回资产信息及内容版本，不含公开目录字段。
export interface MediaAssetResponse {
  id: string; original_name: string; mime_type: string; byte_size: number; version: number; series_version?: number;
}
// 管理端删除电影或整剧前读取的名称、版本和关联数量。
export interface DeleteImpactResponse {
  name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
// 管理端删除季或单集前读取的显示名称、版本和关联数量。
export interface ChildDeleteImpactResponse {
  display_name: string; version: number; season_count: number; episode_count: number;
  media_count: number;
}
// 管理删除操作成功后返回的同步删除媒体数量。
export interface DeleteResultResponse {
  deleted_media_count: number;
}
