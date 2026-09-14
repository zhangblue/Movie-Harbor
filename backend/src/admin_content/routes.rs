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
enum AdminContentError {
    Invalid,
    Database,
}

impl From<DbErr> for AdminContentError {
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for AdminContentError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid content list request"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

pub fn router(auth_state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/contents", get(list))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::routes::require_session,
        ))
        .with_state(auth_state)
}

async fn list(
    State(state): State<AuthState>,
    Query(request): Query<AdminContentRequest>,
) -> Result<Json<AdminContentPage>, AdminContentError> {
    let filter = AdminContentFilter::try_from(request).map_err(|_| AdminContentError::Invalid)?;
    Ok(Json(query::list(&state.db, filter).await?))
}
