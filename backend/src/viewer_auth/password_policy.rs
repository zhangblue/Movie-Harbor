use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

pub(crate) struct InvalidPassword;

impl IntoResponse for InvalidPassword {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"密码至少需要 8 个字符。"})),
        )
            .into_response()
    }
}

// 普通用户独立规则；不得加入管理员共用的密码哈希/校验模块。
pub(crate) fn validate(password: &str) -> Result<(), InvalidPassword> {
    if password.trim().is_empty() || password.chars().count() < 8 {
        return Err(InvalidPassword);
    }
    Ok(())
}
