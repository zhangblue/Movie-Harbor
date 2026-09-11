use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub name: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct PasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub name: String,
    pub csrf_token: String,
}

pub struct AuthError(pub StatusCode);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let message = match self.0 {
            StatusCode::UNAUTHORIZED => "authentication failed",
            StatusCode::FORBIDDEN => "request forbidden",
            StatusCode::TOO_MANY_REQUESTS => "too many login attempts",
            StatusCode::BAD_REQUEST => "invalid request",
            _ => "internal server error",
        };
        (self.0, Json(serde_json::json!({"error": message}))).into_response()
    }
}

impl From<sea_orm::DbErr> for AuthError {
    fn from(_: sea_orm::DbErr) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR)
    }
}
