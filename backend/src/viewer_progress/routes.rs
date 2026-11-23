use super::{dto::*, service};
use crate::{auth::AuthState, route_params::parse_uuid, viewer_auth};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use sea_orm::TransactionTrait;
use std::collections::HashSet;

#[derive(Debug)]
/// 表示进度请求参数、目标或数据库错误，供路由返回稳定状态。
pub enum ProgressError {
    Invalid,
    NotFound,
    Database,
}

impl From<service::ServiceError> for ProgressError {
    /// 将服务错误映射为不泄露数据库细节的路由错误。
    fn from(error: service::ServiceError) -> Self {
        match error {
            service::ServiceError::Invalid => Self::Invalid,
            service::ServiceError::NotFound => Self::NotFound,
            service::ServiceError::Database => Self::Database,
        }
    }
}

impl IntoResponse for ProgressError {
    /// 将进度错误转换为 JSON HTTP 响应，供处理器失败时调用。
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid progress request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "content not found"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}

/// 构建普通用户观看进度路由，并复用现有会话、同源和 CSRF 中间件。
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/viewer/progress", get(read))
        .route("/api/viewer/progress/merge", post(merge))
        .route(
            "/api/viewer/progress/{kind}/{id}",
            put(write).delete(remove),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            viewer_auth::routes::require_session,
        ))
        .with_state(state)
}

/// 读取当前普通用户规范进度快照。
async fn read(
    State(state): State<AuthState>,
    Extension(current): Extension<viewer_auth::session::CurrentSession>,
) -> Result<Json<ProgressSnapshot>, ProgressError> {
    Ok(Json(service::snapshot(&state.db, current.viewer.id).await?))
}

/// 解析删除范围路由参数，供单条删除处理器复用。
fn removal_kind(value: &str) -> Result<RemovalTargetKind, ProgressError> {
    match value {
        "movie" => Ok(RemovalTargetKind::Movie),
        "episode" => Ok(RemovalTargetKind::Episode),
        "series" => Ok(RemovalTargetKind::Series),
        _ => Err(ProgressError::NotFound),
    }
}

/// 保存单条电影、单集或整剧删除墓碑并返回最新规范快照。
async fn remove(
    State(state): State<AuthState>,
    Extension(current): Extension<viewer_auth::session::CurrentSession>,
    Path((kind, id)): Path<(String, String)>,
    Json(input): Json<RemovalRequest>,
) -> Result<Json<ProgressSnapshot>, ProgressError> {
    let id = parse_uuid(id, ProgressError::NotFound)?;
    let tx = state
        .db
        .begin()
        .await
        .map_err(|_| ProgressError::Database)?;
    service::remove(
        &tx,
        current.viewer.id,
        RemovalInput {
            kind: removal_kind(&kind)?,
            id,
            removed_at: input.removed_at,
        },
    )
    .await?;
    let snapshot = service::snapshot(&tx, current.viewer.id).await?;
    tx.commit().await.map_err(|_| ProgressError::Database)?;
    Ok(Json(snapshot))
}

/// 写入一条电影或单集进度并返回最新规范快照。
async fn write(
    State(state): State<AuthState>,
    Extension(current): Extension<viewer_auth::session::CurrentSession>,
    Path((kind, id)): Path<(String, String)>,
    Json(input): Json<ProgressInput>,
) -> Result<Json<ProgressSnapshot>, ProgressError> {
    let kind = match kind.as_str() {
        "movie" => PlaybackTargetKind::Movie,
        "episode" => PlaybackTargetKind::Episode,
        _ => return Err(ProgressError::NotFound),
    };
    let id = parse_uuid(id, ProgressError::NotFound)?;
    let tx = state
        .db
        .begin()
        .await
        .map_err(|_| ProgressError::Database)?;
    service::put_progress(&tx, current.viewer.id, kind, id, input).await?;
    let snapshot = service::snapshot(&tx, current.viewer.id).await?;
    tx.commit().await.map_err(|_| ProgressError::Database)?;
    Ok(Json(snapshot))
}

/// 在单事务中合并一批进度和游标，并返回逐项结果及规范快照。
async fn merge(
    State(state): State<AuthState>,
    Extension(current): Extension<viewer_auth::session::CurrentSession>,
    Json(input): Json<MergeRequest>,
) -> Result<Json<ProgressSnapshot>, ProgressError> {
    if input.progress.len() + input.cursors.len() + input.removals.len() > 500 {
        return Err(ProgressError::Invalid);
    }
    let mut targets = HashSet::new();
    for progress in &input.progress {
        if !targets.insert(format!("{:?}:{}", progress.kind, progress.id)) {
            return Err(ProgressError::Invalid);
        }
    }
    for removal in &input.removals {
        if !targets.insert(format!("{:?}:{}", removal.kind, removal.id)) {
            return Err(ProgressError::Invalid);
        }
    }
    let mut cursor_series = HashSet::new();
    if input
        .cursors
        .iter()
        .any(|cursor| !cursor_series.insert(cursor.series_id))
    {
        return Err(ProgressError::Invalid);
    }
    let tx = state
        .db
        .begin()
        .await
        .map_err(|_| ProgressError::Database)?;
    let mut results = Vec::new();
    for progress in input.progress {
        let (kind, id, progress) = service::split_progress(progress);
        match service::put_progress(&tx, current.viewer.id, kind, id, progress).await {
            Ok(status) => results.push(service::result("progress", id, status)),
            Err(service::ServiceError::NotFound) => results.push(service::rejected("progress", id)),
            Err(error) => return Err(error.into()),
        }
    }
    for cursor in input.cursors {
        // 回执使用剧集 ID，与客户端游标键保持一致，才能精确清理失效游标。
        let id = cursor.series_id;
        match service::put_cursor(&tx, current.viewer.id, cursor).await {
            Ok(status) => results.push(service::result("cursor", id, status)),
            Err(service::ServiceError::NotFound) => results.push(service::rejected("cursor", id)),
            Err(error) => return Err(error.into()),
        }
    }
    for removal in input.removals {
        let id = removal.id;
        match service::remove(&tx, current.viewer.id, removal).await {
            Ok(status) => results.push(service::result("removal", id, status)),
            Err(service::ServiceError::NotFound) => results.push(service::rejected("removal", id)),
            Err(error) => return Err(error.into()),
        }
    }
    let mut snapshot = service::snapshot(&tx, current.viewer.id).await?;
    snapshot.results = results;
    tx.commit().await.map_err(|_| ProgressError::Database)?;
    Ok(Json(snapshot))
}
