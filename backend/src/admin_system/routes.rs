use super::{
    dto::{BackupOverview, OverviewWarning, SystemOverview, VolumeOverview},
    query,
};
use crate::{
    auth::{self, AuthState},
    media::{LocalMediaStorage, MEDIA_CAPACITY_RESERVE_BYTES},
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    middleware::{self, map_response},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use sea_orm::{AccessMode, DbErr, IsolationLevel, TransactionTrait};

#[derive(Clone)]
/// 保存系统概览查询需要的数据库与已验证媒体存储句柄。
struct AdminSystemState {
    auth: AuthState,
    storage: LocalMediaStorage,
}

#[derive(Debug)]
/// 表示系统概览数据库失败，避免向客户端返回底层错误。
enum AdminSystemError {
    Database,
}

impl From<DbErr> for AdminSystemError {
    /// 将所有数据库错误收敛为统一服务器错误。
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for AdminSystemError {
    /// 返回不包含连接、SQL 或路径信息的稳定错误体。
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"internal server error"})),
        )
            .into_response()
    }
}

/// 构建只允许管理员读取的系统概览路由。
pub fn router(auth_state: AuthState, storage: LocalMediaStorage) -> Router {
    let state = AdminSystemState {
        auth: auth_state.clone(),
        storage,
    };
    Router::new()
        .route("/api/admin/system/overview", get(overview))
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        // 此层位于认证层外侧，确保认证中间件的通用 no-store 不会丢失 private 属性。
        .route_layer(map_response(private_cache))
        .with_state(state)
}

/// 为系统概览的成功与失败响应设置私有且不可存储的缓存策略。
async fn private_cache(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

/// 在一个只读一致性事务中读取摘要，并与独立时点的容量采样组合响应。
async fn overview(
    State(state): State<AdminSystemState>,
) -> Result<Json<SystemOverview>, AdminSystemError> {
    let transaction = state
        .auth
        .db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let counts = match query::summary(&transaction).await {
        Ok(counts) => counts,
        Err(error) => {
            // 摘要失败时主动结束事务，避免把仍待回滚的连接占在池中。
            transaction.rollback().await?;
            return Err(error.into());
        }
    };
    transaction.commit().await?;
    let asset_count = counts.posters.count.saturating_add(counts.videos.count);
    let recorded_asset_bytes = counts.posters.bytes.saturating_add(counts.videos.bytes);
    let (volume, warnings) = match state.storage.capacity() {
        Ok(capacity) => {
            let accepts_uploads = capacity.available_bytes > MEDIA_CAPACITY_RESERVE_BYTES;
            let writable_bytes = capacity
                .available_bytes
                .saturating_sub(MEDIA_CAPACITY_RESERVE_BYTES);
            let status = if accepts_uploads {
                "healthy"
            } else {
                "space_low"
            };
            let warnings = if accepts_uploads {
                Vec::new()
            } else {
                vec![OverviewWarning {
                    code: "storage_space_low",
                    scope: "volume:0",
                    message: "媒体卷空间不足",
                }]
            };
            (
                VolumeOverview {
                    number: 0,
                    status,
                    total_bytes: Some(capacity.total_bytes),
                    available_bytes: Some(capacity.available_bytes),
                    reserve_bytes: MEDIA_CAPACITY_RESERVE_BYTES,
                    writable_bytes: Some(writable_bytes),
                    accepts_uploads,
                    asset_count,
                    recorded_asset_bytes,
                },
                warnings,
            )
        }
        Err(_) => (
            VolumeOverview {
                number: 0,
                status: "unavailable",
                total_bytes: None,
                available_bytes: None,
                reserve_bytes: MEDIA_CAPACITY_RESERVE_BYTES,
                writable_bytes: None,
                accepts_uploads: false,
                asset_count,
                recorded_asset_bytes,
            },
            vec![OverviewWarning {
                code: "storage_capacity_unavailable",
                scope: "volume:0",
                message: "无法读取媒体卷容量",
            }],
        ),
    };
    let status = if warnings.is_empty() {
        "healthy"
    } else {
        "attention"
    };
    Ok(Json(SystemOverview {
        sampled_at: Utc::now().fixed_offset().to_rfc3339(),
        application_version: env!("CARGO_PKG_VERSION"),
        status,
        counts,
        volumes: vec![volume],
        backup: BackupOverview {
            status: "unverifiable",
        },
        warnings,
    }))
}
