use super::{
    dto::{
        AdminPasswordRequest, CreateViewerRequest, DeleteViewerRequest, ViewerUserFilter,
        ViewerUserPage, ViewerUserRequest, ViewerUserSummary,
    },
    service::{self, ViewerUserError},
};
use crate::{
    auth::{self, AuthState},
    route_params::parse_uuid,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    routing::{delete, get, put},
};

// 构建受管理员认证保护的用户管理路由，供应用启动时聚合。
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/users", get(list).post(create))
        .route("/api/admin/users/{id}/password", put(change_password))
        .route("/api/admin/users/{id}", delete(delete_user))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::routes::require_session,
        ))
        .with_state(state)
}

// 解析筛选条件并返回用户分页，供管理列表请求调用。
async fn list(
    State(state): State<AuthState>,
    Query(request): Query<ViewerUserRequest>,
) -> Result<Json<ViewerUserPage>, ViewerUserError> {
    Ok(Json(
        service::list(&state.db, ViewerUserFilter::try_from(request)?).await?,
    ))
}

// 创建普通用户，供管理员创建账号请求调用。
async fn create(
    State(state): State<AuthState>,
    Json(request): Json<CreateViewerRequest>,
) -> Result<(StatusCode, Json<ViewerUserSummary>), ViewerUserError> {
    Ok((
        StatusCode::CREATED,
        Json(service::create(&state, request.username, request.password).await?),
    ))
}

// 按版本重置普通用户密码，供管理员改密请求调用。
async fn change_password(
    State(state): State<AuthState>,
    Path(id): Path<String>,
    Json(request): Json<AdminPasswordRequest>,
) -> Result<Json<ViewerUserSummary>, ViewerUserError> {
    let id = parse_uuid(id, ViewerUserError::Invalid)?;
    Ok(Json(
        service::change_password(&state, id, request.version, request.new_password).await?,
    ))
}

// 按版本删除普通用户，供管理员删除请求调用。
async fn delete_user(
    State(state): State<AuthState>,
    Path(id): Path<String>,
    Json(request): Json<DeleteViewerRequest>,
) -> Result<StatusCode, ViewerUserError> {
    let id = parse_uuid(id, ViewerUserError::Invalid)?;
    service::delete(&state.db, id, request.version).await?;
    Ok(StatusCode::NO_CONTENT)
}
