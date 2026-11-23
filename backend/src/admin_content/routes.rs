use super::{
    dto::{
        AdminContentFilter, AdminContentPage, AdminContentRequest, BulkActionRequest,
        BulkActionResponse, MissingVideoFilter, MissingVideoPage, MissingVideoRequest,
    },
    query, service,
};
use crate::auth::{self, AuthState};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sea_orm::DbErr;

#[derive(Debug)]
// 表示管理内容列表错误，供路由转换 HTTP 响应。
enum AdminContentError {
    InvalidList,
    InvalidBulk,
    BulkValidation(Vec<super::dto::BulkProblem>),
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
        match self {
            Self::InvalidList => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid content list request"})),
            )
                .into_response(),
            Self::InvalidBulk => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid bulk action request"})),
            )
                .into_response(),
            Self::BulkValidation(problems) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"bulk_validation_failed","problems":problems})),
            )
                .into_response(),
            Self::Database => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error":"internal server error"})),
            )
                .into_response(),
        }
    }
}

// 构建受管理员认证保护的内容列表路由，供应用启动时聚合。
pub fn router(auth_state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/contents", get(list))
        .route(
            "/api/admin/contents/missing-videos",
            get(list_missing_videos),
        )
        .route("/api/admin/contents/bulk-actions", post(bulk_action))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::routes::require_session,
        ))
        .with_state(auth_state)
}

/// 解析并执行一次管理员批量内容动作，领域问题以稳定 409 结构完整返回。
async fn bulk_action(
    State(state): State<AuthState>,
    Json(value): Json<serde_json::Value>,
) -> Result<Json<BulkActionResponse>, AdminContentError> {
    let request =
        BulkActionRequest::from_value(value).map_err(|_| AdminContentError::InvalidBulk)?;
    match service::execute_bulk_action(&state.db, request).await {
        Ok(response) => Ok(Json(response)),
        Err(service::BulkActionError::Validation(problems)) => {
            Err(AdminContentError::BulkValidation(problems))
        }
        Err(service::BulkActionError::Database) => Err(AdminContentError::Database),
    }
}

// 校验筛选条件并查询管理内容，供列表请求调用。
async fn list(
    State(state): State<AuthState>,
    Query(request): Query<AdminContentRequest>,
) -> Result<Json<AdminContentPage>, AdminContentError> {
    let filter =
        AdminContentFilter::try_from(request).map_err(|_| AdminContentError::InvalidList)?;
    Ok(Json(query::list(&state.db, filter).await?))
}

// 解析缺视频查询的显式类型和页码，再返回管理端当前页的只读结果。
async fn list_missing_videos(
    State(state): State<AuthState>,
    request: Result<Query<MissingVideoRequest>, QueryRejection>,
) -> Result<Json<MissingVideoPage>, AdminContentError> {
    // 统一处理解析与范围校验错误，避免把请求参数原文或解析细节返回给调用方。
    let Query(request) = request.map_err(|_| AdminContentError::InvalidList)?;
    let filter =
        MissingVideoFilter::try_from(request).map_err(|_| AdminContentError::InvalidList)?;
    Ok(Json(query::list_missing_videos(&state.db, filter).await?))
}
