pub use crate::auth::model::PasswordRequest;
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

pub struct AuthError(pub StatusCode);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        if self.0 == StatusCode::UNAUTHORIZED {
            return (
                self.0,
                [("cache-control", "no-store")],
                Json(serde_json::json!({"error":"用户名或密码错误"})),
            )
                .into_response();
        }
        crate::auth::model::AuthError(self.0).into_response()
    }
}

impl From<crate::auth::model::AuthError> for AuthError {
    fn from(error: crate::auth::model::AuthError) -> Self {
        Self(error.0)
    }
}

impl From<sea_orm::DbErr> for AuthError {
    fn from(_: sea_orm::DbErr) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub username: String,
    pub csrf_token: String,
}
