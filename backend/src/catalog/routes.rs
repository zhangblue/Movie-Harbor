use super::{
    dto::{CatalogFilter, CatalogRequest, MovieDetail, SeriesDetail},
    query,
};
use crate::route_params::parse_uuid;
use crate::viewer_auth::session::authenticate_optional;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::map_response,
    response::{IntoResponse, Response},
    routing::get,
};
use sea_orm::{DatabaseConnection, DbErr};

#[derive(Clone)]
// 保存目录路由数据库连接，供公开目录请求共享。
struct CatalogState {
    db: DatabaseConnection,
}

#[derive(Debug)]
// 表示公开目录参数、不可见内容或数据库错误，供路由使用。
enum CatalogError {
    Invalid,
    NotFound,
    Database,
}

impl From<DbErr> for CatalogError {
    // 将数据库错误映射为目录错误，供目录查询失败时调用。
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for CatalogError {
    // 将目录错误转换为 HTTP 响应，供公开路由失败时调用。
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid catalog request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "content not found"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

// 构建公开目录和详情路由，供应用启动时聚合。
pub fn router(db: DatabaseConnection) -> Router {
    Router::new()
        .route("/api/catalog", get(list))
        .route("/api/catalog/movies/{id}", get(movie_detail))
        .route("/api/catalog/series/{id}", get(series_detail))
        .layer(map_response(private_cache))
        .with_state(CatalogState { db })
}

// 设置私有且不可存储的缓存策略，供目录响应中间件调用。
async fn private_cache(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .append(header::VARY, HeaderValue::from_static("Cookie"));
    response
}

// 判断普通用户会话是否允许查看私密内容，供目录查询前调用。
async fn include_private(state: &CatalogState, headers: &HeaderMap) -> Result<bool, CatalogError> {
    // 管理员 Cookie 永不参与目录授权；无效普通用户会话降为匿名，数据库故障仍返回 500。
    authenticate_optional(&state.db, headers)
        .await
        .map(|session| session.is_some())
        .map_err(|_| CatalogError::Database)
}

// 校验筛选并按访客权限返回目录，供公开列表请求调用。
async fn list(
    State(state): State<CatalogState>,
    headers: HeaderMap,
    Query(request): Query<CatalogRequest>,
) -> Result<Json<super::dto::CatalogPage>, CatalogError> {
    let filter = CatalogFilter::try_from(request).map_err(|_| CatalogError::Invalid)?;
    // 列表查询前确定普通用户权限；认证存储失败时中止响应，避免错误放行。
    let include_private = include_private(&state, &headers).await?;
    Ok(Json(query::list(&state.db, filter, include_private).await?))
}

// 按访客权限返回电影详情，供公开电影详情请求调用。
async fn movie_detail(
    State(state): State<CatalogState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<MovieDetail>, CatalogError> {
    // 非法 ID 与查询层过滤掉的未公开内容都返回 404，不向访客区分后台状态。
    let id = parse_uuid(id, CatalogError::NotFound)?;
    let include_private = include_private(&state, &headers).await?;
    query::movie_detail(&state.db, id, include_private)
        .await?
        .map(Json)
        .ok_or(CatalogError::NotFound)
}

// 按访客权限返回剧集详情，供公开剧集详情请求调用。
async fn series_detail(
    State(state): State<CatalogState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<SeriesDetail>, CatalogError> {
    // 剧集详情沿用相同的不可见语义，草稿、已归档和不存在的记录均返回 404。
    let id = parse_uuid(id, CatalogError::NotFound)?;
    let include_private = include_private(&state, &headers).await?;
    query::series_detail(&state.db, id, include_private)
        .await?
        .map(Json)
        .ok_or(CatalogError::NotFound)
}
