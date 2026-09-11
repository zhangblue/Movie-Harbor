use super::{csrf, model::AuthError};
use crate::entities::{admin_session, admin_user};
use axum::http::{HeaderMap, StatusCode};
use chrono::Utc;
use rand_core::{OsRng, RngCore};
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};

pub const COOKIE_NAME: &str = "mh_session";
const SESSION_SECONDS: i64 = 86400;

#[derive(Clone)]
pub struct CurrentSession {
    pub session: admin_session::Model,
    pub admin: admin_user::Model,
    pub csrf_token: String,
}

pub fn cookie(token: &str, secure: bool, clear: bool) -> String {
    format!(
        "{COOKIE_NAME}={token}; Path=/api/admin; HttpOnly; SameSite=Lax; Max-Age={}{}",
        if clear { 0 } else { SESSION_SECONDS },
        if secure { "; Secure" } else { "" }
    )
}

pub async fn create<C: ConnectionTrait>(
    db: &C,
    admin: &admin_user::Model,
) -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let raw: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    admin_session::ActiveModel {
        id: Set(uuid::Uuid::new_v4()),
        admin_user_id: Set(admin.id),
        token_hash: Set(csrf::digest(&raw)),
        csrf_token_hash: Set(csrf::digest(&csrf::token(&raw))),
        expires_at: Set((Utc::now() + chrono::Duration::seconds(SESSION_SECONDS)).fixed_offset()),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(raw)
}

pub async fn authenticate<C: ConnectionTrait>(
    db: &C,
    headers: &HeaderMap,
) -> Result<CurrentSession, AuthError> {
    let unauthorized = || AuthError(StatusCode::UNAUTHORIZED);
    let raw = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|header| {
            header.split(';').find_map(|pair| {
                pair.trim()
                    .split_once('=')
                    .filter(|(name, _)| *name == COOKIE_NAME)
                    .map(|(_, value)| value)
            })
        })
        .ok_or_else(unauthorized)?;
    if raw.len() != 64 || !raw.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(unauthorized());
    }
    let session = admin_session::Entity::find()
        .filter(admin_session::Column::TokenHash.eq(csrf::digest(raw)))
        .filter(admin_session::Column::ExpiresAt.gt(Utc::now().fixed_offset()))
        .one(db)
        .await?
        .ok_or_else(unauthorized)?;
    let admin = admin_user::Entity::find_by_id(session.admin_user_id)
        .one(db)
        .await?
        .ok_or_else(unauthorized)?;
    Ok(CurrentSession {
        session,
        admin,
        csrf_token: csrf::token(raw),
    })
}

pub fn authorize_write(
    current: &CurrentSession,
    headers: &HeaderMap,
    secure: bool,
) -> Result<(), AuthError> {
    let token = headers.get("x-csrf-token").and_then(|v| v.to_str().ok());
    if !csrf::same_origin(headers, secure)
        || !token.is_some_and(|token| csrf::matches(token, &current.session.csrf_token_hash))
    {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    Ok(())
}
