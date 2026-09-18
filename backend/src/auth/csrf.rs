use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn digest(value: &str) -> String {
    // 会话与 CSRF 的数据库字段只保存 SHA-256 摘要，泄露记录时不能直接复用原始令牌。
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// 随机且仅 HttpOnly Cookie 可见的会话令牌才是秘密；固定前缀把 CSRF 令牌置于独立派生域。
pub fn token(session_token: &str) -> String {
    digest(&format!("movie-harbor:csrf:v1:{session_token}"))
}

pub fn matches(value: &str, stored_digest: &str) -> bool {
    // 先摘要再以常量时间比较，避免根据首个不匹配位置泄露已存令牌摘要的信息。
    digest(value)
        .as_bytes()
        .ct_eq(stored_digest.as_bytes())
        .into()
}

pub fn same_origin(headers: &HeaderMap, configured: &url::Url) -> bool {
    // 写请求必须同时带可解析的 Host 和 Origin；缺失任一项时采用拒绝而非宽松回退。
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if host.parse::<axum::http::uri::Authority>().is_err() {
        return false;
    }
    // Origin 和 Host 都须归一到配置的公开源，防止只伪造其中一个请求头绕过同源限制。
    let Some(origin) = crate::config::parse_origin(origin) else {
        return false;
    };
    let Some(request_origin) =
        crate::config::parse_origin(&format!("{}://{host}", configured.scheme()))
    else {
        return false;
    };
    origin.origin() == configured.origin() && request_origin.origin() == configured.origin()
}
