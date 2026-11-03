use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
// 承载管理员登录凭据，供登录路由解析请求。
pub struct LoginRequest {
    pub name: String,
    pub password: String,
}

#[derive(Deserialize)]
// 承载当前密码和新密码，供密码修改路由解析请求。
pub struct PasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
// 承载管理员会话信息，供认证路由返回。
pub struct SessionResponse {
    pub name: String,
    pub csrf_token: String,
}

// 承载认证错误状态，供认证流程向 HTTP 响应转换。
pub struct AuthError(pub StatusCode);

impl IntoResponse for AuthError {
    // 将认证错误转换为不可缓存的 HTTP 响应，供路由错误处理调用。
    fn into_response(self) -> Response {
        // 认证失败统一返回固定文案，并禁止缓存错误响应，避免泄露具体凭据或会话状态。
        let message = match self.0 {
            StatusCode::UNAUTHORIZED => "authentication failed",
            StatusCode::FORBIDDEN => "request forbidden",
            StatusCode::TOO_MANY_REQUESTS => "too many login attempts",
            StatusCode::BAD_REQUEST => "invalid request",
            _ => "internal server error",
        };
        (
            self.0,
            [("cache-control", "no-store")],
            Json(serde_json::json!({"error": message})),
        )
            .into_response()
    }
}

impl From<sea_orm::DbErr> for AuthError {
    // 将数据库错误映射为认证服务错误，供数据库操作失败时调用。
    fn from(_: sea_orm::DbErr) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR)
    }
}
