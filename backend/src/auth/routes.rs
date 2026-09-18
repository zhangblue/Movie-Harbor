use super::{
    AuthState, csrf,
    model::{AuthError, LoginRequest, PasswordRequest, SessionResponse},
    password, session,
};
use crate::entities::{admin_session, admin_user};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use std::net::SocketAddr;
use tokio::time::Instant;

pub fn router(state: AuthState) -> Router {
    let protected = Router::new()
        .route("/api/admin/session", get(read_session))
        .route("/api/admin/logout", post(logout))
        .route("/api/admin/password", post(change_password))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));
    Router::new()
        .route("/api/admin/login", post(login))
        .merge(protected)
        .with_state(state)
}

/// 此中间件适用于所有需要认证的管理路由，包括未来新增的领域写操作。
pub async fn require_session(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    // 先从 Cookie 查找未过期会话；认证失败时不会把请求交给受保护的业务处理器。
    let current = session::authenticate(&state.db, request.headers()).await?;
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        // 读请求不要求 CSRF；其余方法必须同时通过 Cookie、CSRF 令牌和同源校验。
        session::authorize_write(&current, request.headers(), &state.public_origin)?;
    }
    request.extensions_mut().insert(current);
    let mut response = next.run(request).await;
    // 认证相关响应不得被浏览器或中间缓存复用，以免暴露会话状态。
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(response)
}

async fn login(
    State(state): State<AuthState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<LoginRequest>,
) -> Result<Response, AuthError> {
    // 登录也要求严格同源，避免第三方站点诱导浏览器携带请求创建会话。
    if !csrf::same_origin(&headers, &state.public_origin) {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    let proxy_authenticated = state.trust_proxy_headers
        && headers
            .get("x-movie-harbor-proxy-token")
            .and_then(|value| value.to_str().ok())
            .zip(state.trusted_proxy_secret_digest.as_deref())
            .is_some_and(|(provided, expected)| csrf::digest(provided) == expected);
    let client_ip = if proxy_authenticated {
        // 仅在反向代理令牌可信且 X-Forwarded-For 是单个地址时采信该头，其他情况使用直连地址。
        headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.contains(','))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or_else(|| address.ip())
    } else {
        address.ip()
    };
    // 限流入场会在数据库查询和 Argon2 前预扣预算，并对同 IP 与同账号同时限速。
    let window = state.limits.for_login(client_ip, &input.name);
    let admission = window
        .admit(Instant::now())
        .await
        .ok_or(AuthError(StatusCode::TOO_MANY_REQUESTS))?;
    let admin = admin_user::Entity::find()
        .one(&state.db)
        .await?
        .ok_or(AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    // 未知账号同样执行一次 Argon2 校验，使失败路径不因账号是否存在而出现明显时差。
    let verified_hash = admin.password_hash.clone();
    let password_ok =
        password::verify_limited(&state.password_work, input.password, verified_hash.clone())
            .await?;
    if !password_ok || input.name != admin.name {
        let limited = admission.failure(Instant::now()).await;
        return Err(AuthError(if limited {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::UNAUTHORIZED
        }));
    }
    let tx = state.db.begin().await?;
    // 在事务内锁住管理员记录，防止密码在事务外的 Argon2 校验期间被并发修改。
    let admin = admin_user::Entity::find_by_id(admin.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    if admin.password_hash != verified_hash || input.name != admin.name {
        // 哈希或名称变化即拒绝本次旧快照验证，不能用已失效密码创建新会话。
        admission.failure(Instant::now()).await;
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let raw = session::create(&tx, &admin).await?;
    tx.commit().await?;
    admission.success().await;
    Ok((
        [
            (
                "set-cookie",
                session::cookie(&raw, state.cookie_secure, false),
            ),
            ("cache-control", "no-store".into()),
        ],
        Json(serde_json::json!({"name":admin.name})),
    )
        .into_response())
}

async fn read_session(
    Extension(current): Extension<session::CurrentSession>,
) -> Result<Response, AuthError> {
    Ok((
        [("cache-control", "no-store")],
        Json(SessionResponse {
            name: current.admin.name,
            csrf_token: current.csrf_token,
        }),
    )
        .into_response())
}

async fn logout(
    State(state): State<AuthState>,
    Extension(current): Extension<session::CurrentSession>,
) -> Result<Response, AuthError> {
    // 登出只删除当前会话记录，并立刻清空浏览器 Cookie；其他设备会话保持不变。
    admin_session::Entity::delete_by_id(current.session.id)
        .exec(&state.db)
        .await?;
    Ok((
        StatusCode::NO_CONTENT,
        [("set-cookie", session::cookie("", state.cookie_secure, true))],
    )
        .into_response())
}

async fn change_password(
    State(state): State<AuthState>,
    Extension(current): Extension<session::CurrentSession>,
    headers: HeaderMap,
    Json(input): Json<PasswordRequest>,
) -> Result<Response, AuthError> {
    // 空白新密码没有有效安全语义，先拒绝以避免计算昂贵的无效哈希。
    if input.new_password.trim().is_empty() {
        return Err(AuthError(StatusCode::BAD_REQUEST));
    }
    let admin = admin_user::Entity::find_by_id(current.admin.id)
        .one(&state.db)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    let verified_hash = admin.password_hash.clone();
    // 先用当前数据库哈希验证旧密码，避免仅凭已认证会话即可直接改密。
    if !password::verify_limited(
        &state.password_work,
        input.current_password,
        verified_hash.clone(),
    )
    .await?
    {
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let hash = password::hash_limited(&state.password_work, input.new_password).await?;
    // 哈希计算放在事务外，缩短行锁持有时间；随后必须在事务内重新确认会话和密码版本。
    let tx = state.db.begin().await?;
    let admin = admin_user::Entity::find_by_id(current.admin.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    // 事务外计算期间，较早的改密可能已撤销当前会话；这里在锁内再次认证。
    session::authenticate(&tx, &headers).await?;
    if admin.password_hash != verified_hash {
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let mut model: admin_user::ActiveModel = admin.into();
    model.password_hash = Set(hash);
    model.updated_at = Set(chrono::Utc::now().fixed_offset());
    model.update(&tx).await?;
    // 密码提交时在同一事务撤销该管理员所有会话，避免旧 Cookie 在并发窗口继续有效。
    admin_session::Entity::delete_many()
        .filter(admin_session::Column::AdminUserId.eq(current.admin.id))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::NO_CONTENT,
        [("set-cookie", session::cookie("", state.cookie_secure, true))],
    )
        .into_response())
}
