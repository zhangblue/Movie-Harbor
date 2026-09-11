use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// The random, HttpOnly session token is the secret; domain separation keeps CSRF independent.
pub fn token(session_token: &str) -> String {
    digest(&format!("movie-harbor:csrf:v1:{session_token}"))
}

pub fn matches(value: &str, stored_digest: &str) -> bool {
    digest(value)
        .as_bytes()
        .ct_eq(stored_digest.as_bytes())
        .into()
}

pub fn same_origin(headers: &HeaderMap, configured: &url::Url) -> bool {
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if host.parse::<axum::http::uri::Authority>().is_err() {
        return false;
    }
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
