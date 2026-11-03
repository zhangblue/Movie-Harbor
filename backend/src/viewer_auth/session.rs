use super::model::AuthError;
use crate::{
    auth::csrf,
    entities::{viewer_session, viewer_user},
};
use axum::http::{HeaderMap, StatusCode};
use chrono::Utc;
use rand_core::{OsRng, RngCore};
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};

pub const COOKIE_NAME: &str = "mh_viewer_session";
const SESSION_SECONDS: i64 = 86400;

#[derive(Clone)]
// 保存已认证普通用户及会话信息，供受保护请求和目录授权使用。
pub struct CurrentSession {
    pub session: viewer_session::Model,
    pub viewer: viewer_user::Model,
    pub csrf_token: String,
}

// 生成普通用户会话 Cookie，供登录和清除会话时调用。
pub fn cookie(token: &str, secure: bool, clear: bool) -> String {
    format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        if clear { 0 } else { SESSION_SECONDS },
        if secure { "; Secure" } else { "" }
    )
}

// 创建普通用户会话并返回原始令牌，供登录成功后调用。
pub async fn create<C: ConnectionTrait>(
    db: &C,
    viewer: &viewer_user::Model,
) -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let raw: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    viewer_session::ActiveModel {
        id: Set(uuid::Uuid::new_v4()),
        viewer_user_id: Set(viewer.id),
        token_hash: Set(csrf::digest(&raw)),
        csrf_token_hash: Set(csrf::digest(&csrf::token(&raw))),
        expires_at: Set((Utc::now() + chrono::Duration::seconds(SESSION_SECONDS)).fixed_offset()),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(raw)
}

// 要求有效普通用户会话，供受保护路由认证时调用。
pub async fn authenticate<C: ConnectionTrait>(
    db: &C,
    headers: &HeaderMap,
) -> Result<CurrentSession, AuthError> {
    authenticate_optional(db, headers)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))
}

// 可选地认证普通用户会话，供公开目录判断私密内容可见性时调用。
pub async fn authenticate_optional<C: ConnectionTrait>(
    db: &C,
    headers: &HeaderMap,
) -> Result<Option<CurrentSession>, AuthError> {
    // 公开目录只接受普通用户 Cookie；缺失、歧义或非法令牌均降为匿名，数据库故障仍传播。
    if headers
        .get_all("cookie")
        .iter()
        .any(|header| header.to_str().is_err())
    {
        return Ok(None);
    }
    let mut tokens = headers
        .get_all("cookie")
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value);
    let Some(raw) = tokens.next() else {
        return Ok(None);
    };
    if tokens.next().is_some()
        || raw.len() != 64
        || !raw.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(None);
    }
    let Some(session) = viewer_session::Entity::find()
        .filter(viewer_session::Column::TokenHash.eq(csrf::digest(raw)))
        .filter(viewer_session::Column::ExpiresAt.gt(Utc::now().fixed_offset()))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let Some(viewer) = viewer_user::Entity::find_by_id(session.viewer_user_id)
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(CurrentSession {
        session,
        viewer,
        csrf_token: csrf::token(raw),
    }))
}

// 校验同源和 CSRF 令牌，供普通用户写请求授权时调用。
pub fn authorize_write(
    current: &CurrentSession,
    headers: &HeaderMap,
    policy: &csrf::OriginPolicy,
) -> Result<(), AuthError> {
    let token = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok());
    if !policy.same_origin(headers)
        || !token.is_some_and(|token| csrf::matches(token, &current.session.csrf_token_hash))
    {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    Ok(())
}
