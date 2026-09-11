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

pub fn same_origin(headers: &HeaderMap, secure: bool) -> bool {
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let scheme = if secure { "https" } else { "http" };
    origin == format!("{scheme}://{host}")
}
