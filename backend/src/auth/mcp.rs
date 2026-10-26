use super::session;
use axum::http::{HeaderMap, Method};
use sha2::{Digest, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Clone)]
#[allow(clippy::large_enum_variant)] // 保持管理主体的 Admin 变体直接承载既有会话类型。
pub enum ManagementPrincipal {
    Admin(session::CurrentSession),
    Mcp { key_digest: String },
}

impl fmt::Debug for ManagementPrincipal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admin(_) => f.write_str("Admin"),
            Self::Mcp { key_digest } => f
                .debug_struct("Mcp")
                .field("key_digest", key_digest)
                .finish(),
        }
    }
}

pub fn route_allowed(method: &Method, path: &str) -> bool {
    let Some(relative) = path.strip_prefix("/api/admin/") else {
        return false;
    };
    let segments: Vec<_> = relative.split('/').collect();
    let uuid = |value: &str| Uuid::parse_str(value).is_ok();
    match *method {
        Method::GET => match segments.as_slice() {
            ["contents" | "genres" | "movies" | "series"] => true,
            ["movies" | "series", id] => uuid(id),
            ["series", series, "seasons", season, "episodes", episode] => {
                uuid(series) && uuid(season) && uuid(episode)
            }
            _ => false,
        },
        Method::POST => match segments.as_slice() {
            ["genres" | "movies" | "series"] | ["media", "posters", "stage"] => true,
            ["movies" | "series", id, "publish"] | ["series", id, "seasons"] => uuid(id),
            ["series", series, "seasons", season, "episodes"] => uuid(series) && uuid(season),
            [
                "series",
                series,
                "seasons",
                season,
                "episodes",
                episode,
                "publish",
            ] => uuid(series) && uuid(season) && uuid(episode),
            ["media", "movies" | "episodes", id, "video"] => uuid(id),
            _ => false,
        },
        Method::PATCH => match segments.as_slice() {
            ["movies" | "series", id] => uuid(id),
            ["series", series, "seasons", season, "episodes", episode] => {
                uuid(series) && uuid(season) && uuid(episode)
            }
            _ => false,
        },
        _ => false,
    }
}

pub fn authenticate(headers: &HeaderMap, expected: Option<&str>) -> Option<ManagementPrincipal> {
    let expected = expected?;
    let mut values = headers.get_all(axum::http::header::AUTHORIZATION).iter();
    let header = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let (scheme, raw) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") || raw.is_empty() {
        return None;
    }
    let unpadded = raw.trim_end_matches('=');
    if unpadded.is_empty()
        || !unpadded.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
        })
    {
        return None;
    }

    let mut expected_bytes = [0u8; 32];
    if expected.len() != 64 {
        return None;
    }
    for (slot, pair) in expected_bytes
        .iter_mut()
        .zip(expected.as_bytes().as_chunks::<2>().0)
    {
        *slot = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    let calculated = Sha256::digest(raw.as_bytes());
    if !bool::from(calculated.as_slice().ct_eq(&expected_bytes)) {
        return None;
    }
    Some(ManagementPrincipal::Mcp {
        key_digest: format!("{calculated:x}"),
    })
}
