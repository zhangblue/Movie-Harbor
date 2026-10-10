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
struct CatalogState {
    db: DatabaseConnection,
}

#[derive(Debug)]
enum CatalogError {
    Invalid,
    NotFound,
    Database,
}

impl From<DbErr> for CatalogError {
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for CatalogError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid catalog request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "content not found"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

pub fn router(db: DatabaseConnection) -> Router {
    Router::new()
        .route("/api/catalog", get(list))
        .route("/api/catalog/movies/{id}", get(movie_detail))
        .route("/api/catalog/series/{id}", get(series_detail))
        .layer(map_response(private_cache))
        .with_state(CatalogState { db })
}

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

async fn include_private(state: &CatalogState, headers: &HeaderMap) -> Result<bool, CatalogError> {
    // 管理员 Cookie 永不参与目录授权；无效普通用户会话降为匿名，数据库故障仍返回 500。
    authenticate_optional(&state.db, headers)
        .await
        .map(|session| session.is_some())
        .map_err(|_| CatalogError::Database)
}

async fn list(
    State(state): State<CatalogState>,
    headers: HeaderMap,
    Query(request): Query<CatalogRequest>,
) -> Result<Json<super::dto::CatalogPage>, CatalogError> {
    let filter = CatalogFilter::try_from(request).map_err(|_| CatalogError::Invalid)?;
    let include_private = include_private(&state, &headers).await?;
    Ok(Json(query::list(&state.db, filter, include_private).await?))
}

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
