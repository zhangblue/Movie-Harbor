use crate::{
    auth::{self, AuthState},
    viewer_auth,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use sea_orm::{ConnectionTrait, DbBackend, Statement};

// Check the ownership index and the actual slot together: stale or malformed ownership fails closed.
// Each branch returns only authorization facts, never file paths or content metadata.
const OWNER_SQL: &str = r#"
SELECT m.status = 'published' AND m.published_at IS NOT NULL AS published, m.is_private
FROM media_asset a JOIN media_asset_ownership o ON o.asset_id = a.id
JOIN movie m ON o.owner_kind = 'movie' AND o.owner_id = m.id
  AND ((o.slot = 'poster' AND m.poster_asset_id = a.id)
    OR (o.slot = 'video' AND m.video_asset_id = a.id))
WHERE a.storage_key = $1 AND a.purpose = $2 AND o.slot = $2
UNION ALL
SELECT s.status = 'published' AND s.published_at IS NOT NULL AS published, s.is_private
FROM media_asset a JOIN media_asset_ownership o ON o.asset_id = a.id
JOIN series s ON o.owner_kind = 'series' AND o.owner_id = s.id
  AND o.slot = 'poster' AND s.poster_asset_id = a.id
WHERE a.storage_key = $1 AND a.purpose = $2 AND o.slot = $2
UNION ALL
SELECT s.status = 'published' AND s.published_at IS NOT NULL
  AND e.status = 'published' AND e.published_at IS NOT NULL AS published, s.is_private
FROM media_asset a JOIN media_asset_ownership o ON o.asset_id = a.id
JOIN episode e ON o.owner_kind = 'episode' AND o.owner_id = e.id
  AND o.slot = 'video' AND e.video_asset_id = a.id
JOIN season se ON se.id = e.season_id
JOIN series s ON s.id = se.series_id
WHERE a.storage_key = $1 AND a.purpose = $2 AND o.slot = $2
"#;

pub(super) async fn authorize(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let allowed = is_allowed(&state, &headers).await.unwrap_or(false);
    (
        if allowed {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
        [(header::CACHE_CONTROL, "private, no-store")],
    )
}

async fn is_allowed(state: &AuthState, headers: &HeaderMap) -> Option<bool> {
    let token = single_header(headers, "x-movie-harbor-proxy-token")?;
    if !state.trust_proxy_headers
        || !auth::csrf::matches(token, state.trusted_proxy_secret_digest.as_deref()?)
    {
        return None;
    }
    let uri = single_header(headers, "x-forwarded-uri")?;
    // Generated URLs are ASCII and need no decoding. Never normalize an attacker-controlled path.
    if !uri.is_ascii() || uri.contains('#') {
        return None;
    }
    let path = uri.split_once('?').map_or(uri, |(path, _)| path);
    let key = path.strip_prefix("/media/")?;
    let (purpose, _) = key.split_once('/')?;
    super::path::controlled_media_url(key, purpose)?;
    let rows = state
        .db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            OWNER_SQL,
            [key.into(), purpose.into()],
        ))
        .await
        .ok()?;
    if rows.len() != 1 {
        return None;
    }
    let owner = &rows[0];
    if auth::session::authenticate(&state.db, headers)
        .await
        .is_ok()
    {
        return Some(true);
    }
    if !owner.try_get::<bool>("", "published").ok()? {
        return Some(false);
    }
    if !owner.try_get::<bool>("", "is_private").ok()? {
        return Some(true);
    }
    Some(
        viewer_auth::session::authenticate_optional(&state.db, headers)
            .await
            .ok()?
            .is_some(),
    )
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}
