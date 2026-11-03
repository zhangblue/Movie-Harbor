use super::{
    dto::{AdminContentFilter, AdminContentPage, AdminContentRequest},
    query,
};
use crate::auth::{self, AuthState};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use sea_orm::DbErr;

#[derive(Debug)]
// 表示管理内容列表错误，供路由转换 HTTP 响应。
enum AdminContentError {
    Invalid,
    Database,
}

impl From<DbErr> for AdminContentError {
    // 将数据库失败映射为列表错误，供查询失败时调用。
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for AdminContentError {
    // 将列表错误转换为 HTTP 响应，供路由失败时调用。
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid content list request"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

// 构建受管理员认证保护的内容列表路由，供应用启动时聚合。
pub fn router(auth_state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/contents", get(list))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::routes::require_session,
        ))
        .with_state(auth_state)
}

// 校验筛选条件并查询管理内容，供列表请求调用。
async fn list(
    State(state): State<AuthState>,
    Query(request): Query<AdminContentRequest>,
) -> Result<Json<AdminContentPage>, AdminContentError> {
    let filter = AdminContentFilter::try_from(request).map_err(|_| AdminContentError::Invalid)?;
    Ok(Json(query::list(&state.db, filter).await?))
}
