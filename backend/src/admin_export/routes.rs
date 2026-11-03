use super::query;
use crate::auth::{self, AuthState};
use axum::{
    Json, Router,
    extract::State,
    http::{
        HeaderValue, StatusCode,
        header::{CONTENT_DISPOSITION, CONTENT_TYPE},
    },
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;

// 表示内容导出失败，供导出路由返回错误响应。
struct ExportError;

impl IntoResponse for ExportError {
    // 将导出失败转换为 HTTP 错误，供导出路由处理失败时调用。
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"internal server error"})),
        )
            .into_response()
    }
}

// 构建受管理员认证保护的导出路由，供应用启动时聚合。
pub fn router(auth_state: AuthState) -> Router {
    // 导出含全部状态的内容和容器内媒体路径，即使只读也必须验证管理员会话。
    Router::new()
        .route("/api/admin/contents/export", get(export))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::routes::require_session,
        ))
        .with_state(auth_state)
}

// 生成全量内容导出附件，供管理员下载请求调用。
async fn export(State(state): State<AuthState>) -> Result<Response, ExportError> {
    let now = Utc::now();
    // 由后端读取完整一致快照；查询失败时不返回部分导出文件。
    let payload = query::export(&state.db, now.to_rfc3339())
        .await
        .map_err(|_| ExportError)?;
    let filename = format!(
        "movie-harbor-content-export-{}.json",
        now.format("%Y%m%d-%H%M%S")
    );
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .map_err(|_| ExportError)?;
    Ok((
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            ),
            (CONTENT_DISPOSITION, disposition),
        ],
        Json(payload),
    )
        .into_response())
}
