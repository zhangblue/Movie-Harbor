use crate::{
    auth::{self, AuthState, mcp::ManagementPrincipal},
    media::LocalMediaStorage,
    route_params::parse_uuid,
};
use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    middleware,
    routing::{get, post, put},
};
use sea_orm::DatabaseConnection;

use super::{
    dto::{
        CreateMovieRequest, DeleteImpactResponse, DeleteResultResponse, MovieListQuery,
        MovieResponse, PrivacyRequest, UpdateMovieRequest, VersionRequest,
    },
    service::{self, MovieError},
};

#[derive(Clone)]
/// 电影路由共享状态，供请求处理器访问数据库和媒体存储。
struct MovieState {
    db: DatabaseConnection,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
}

/// 在组装应用路由时注册当前领域的接口及共享状态。
pub fn router(
    auth_state: AuthState,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
) -> Router {
    let state = MovieState {
        db: auth_state.db.clone(),
        storage,
        allowed_video_mime_types,
    };
    Router::new()
        .route("/api/admin/movies", get(list).post(create))
        .route("/api/admin/movies/{id}/privacy", put(set_privacy))
        .route(
            "/api/admin/movies/{id}",
            get(detail).patch(update).delete(delete_movie),
        )
        .route("/api/admin/movies/{id}/publish", post(publish))
        .route("/api/admin/movies/{id}/archive", post(archive))
        .route("/api/admin/movies/{id}/draft", post(revert_to_draft))
        .route("/api/admin/movies/{id}/delete-impact", get(delete_impact))
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        .with_state(state)
}

/// 在列表请求中读取符合筛选条件的内容并组装响应。
async fn list(
    State(state): State<MovieState>,
    Query(query): Query<MovieListQuery>,
) -> Result<Json<Vec<MovieResponse>>, MovieError> {
    Ok(Json(service::list(&state.db, query).await?))
}

/// 在创建请求中建立初始内容并返回响应。
async fn create(
    State(state): State<MovieState>,
    Extension(principal): Extension<ManagementPrincipal>,
    Json(input): Json<CreateMovieRequest>,
) -> Result<(StatusCode, Json<MovieResponse>), MovieError> {
    Ok((
        StatusCode::CREATED,
        Json(match principal {
            ManagementPrincipal::Admin(_) => {
                service::create(&state.db, input.name, input.is_private).await?
            }
            ManagementPrincipal::Mcp { key_digest } => {
                service::create_mcp(&state.db, input, &key_digest).await?
            }
        }),
    ))
}

/// 在访问范围变更请求中按版本修改隐私设置并返回更新结果。
async fn set_privacy(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<PrivacyRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::set_privacy(
            &state.db,
            parse_uuid(id, MovieError::Invalid)?,
            input.version,
            input.is_private,
        )
        .await?,
    ))
}

/// 在详情请求中读取指定内容并组装关联数据。
async fn detail(
    State(state): State<MovieState>,
    Path(id): Path<String>,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::detail(&state.db, parse_uuid(id, MovieError::Invalid)?).await?,
    ))
}

/// 在编辑请求中校验状态和版本后保存内容。
async fn update(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateMovieRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::update(&state.db, parse_uuid(id, MovieError::Invalid)?, input).await?,
    ))
}

/// 在发布请求中委托状态转换并返回更新后的内容。
async fn publish(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "published").await
}

/// 在归档请求中委托状态转换并返回更新后的内容。
async fn archive(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "archived").await
}

/// 在恢复草稿请求中委托状态转换并返回更新后的内容。
async fn revert_to_draft(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "draft").await
}

/// 在生命周期请求中校验目标状态和版本后执行转换。
async fn transition(
    state: MovieState,
    id: String,
    input: VersionRequest,
    target: &str,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::transition(
            &state.db,
            &state.storage,
            &state.allowed_video_mime_types,
            parse_uuid(id, MovieError::Invalid)?,
            input.version,
            target,
        )
        .await?,
    ))
}

/// 在电影删除请求中调用服务执行版本校验、删除及媒体清理。
async fn delete_movie(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<DeleteResultResponse>, MovieError> {
    Ok(Json(
        service::delete(
            &state.db,
            &state.storage,
            parse_uuid(id, MovieError::Invalid)?,
            input.version,
        )
        .await?,
    ))
}

/// 在删除预览请求中统计受影响的内容与媒体。
async fn delete_impact(
    State(state): State<MovieState>,
    Path(id): Path<String>,
) -> Result<Json<DeleteImpactResponse>, MovieError> {
    Ok(Json(
        service::delete_impact(&state.db, parse_uuid(id, MovieError::Invalid)?).await?,
    ))
}
