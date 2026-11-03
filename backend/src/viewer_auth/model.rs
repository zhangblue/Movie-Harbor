pub use crate::auth::model::PasswordRequest;
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

// 承载普通用户认证错误，供登录和会话路由返回。
pub struct AuthError(pub StatusCode);

impl IntoResponse for AuthError {
    // 将普通用户认证错误转换为 HTTP 响应，供路由错误处理调用。
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
    // 在普通用户认证调用公共密码或会话能力失败时，保留底层认证错误的 HTTP 状态。
    fn from(error: crate::auth::model::AuthError) -> Self {
        Self(error.0)
    }
}

impl From<sea_orm::DbErr> for AuthError {
    // 在普通用户认证的数据库读写失败时返回内部错误，不向客户端暴露数据库详情。
    fn from(_: sea_orm::DbErr) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

#[derive(Deserialize)]
// 承载普通用户登录凭据，供登录路由解析请求。
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
// 承载普通用户会话信息，供登录和会话路由返回。
pub struct SessionResponse {
    pub username: String,
    pub csrf_token: String,
}
