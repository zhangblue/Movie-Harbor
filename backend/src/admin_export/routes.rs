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

struct ExportError;

impl IntoResponse for ExportError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"internal server error"})),
        )
            .into_response()
    }
}

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

async fn export(State(state): State<AuthState>) -> Result<Response, ExportError> {
    let now = Utc::now();
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
