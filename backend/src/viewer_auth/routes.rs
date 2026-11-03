use super::{
    model::{AuthError, LoginRequest, PasswordRequest, SessionResponse},
    password_policy, session,
};
use crate::{
    auth::{AuthState, csrf, password},
    entities::{viewer_session, viewer_user},
};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use std::net::SocketAddr;
use tokio::time::Instant;

// 固定、有效且与默认 Argon2id 参数等成本的摘要。未知账号也必须执行密码计算。
const UNKNOWN_USER_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$bW92aWUtaGFyYm9yLWR1bW15$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// 构建普通用户认证路由，供应用启动聚合时调用。
pub fn router(state: AuthState) -> Router {
    let protected = Router::new()
        .route("/api/viewer/session", get(read_session))
        .route("/api/viewer/logout", post(logout))
        .route("/api/viewer/password", patch(change_password))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));
    Router::new()
        .route("/api/viewer/login", post(login))
        .merge(protected)
        .with_state(state)
}

// 要求普通用户会话并校验写请求，供受保护路由中间件调用。
pub async fn require_session(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    if !state.origin_policy.host_allowed(request.headers()) {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    // 进入业务处理器前确认会话有效；失败时直接拒绝，写请求还需同源与 CSRF 校验。
    let current = session::authenticate(&state.db, request.headers()).await?;
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        session::authorize_write(&current, request.headers(), &state.origin_policy)?;
    }
    request.extensions_mut().insert(current);
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(response)
}

// 校验普通用户凭据并创建会话，供登录请求调用。
async fn login(
    State(state): State<AuthState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<LoginRequest>,
) -> Result<Response, AuthError> {
    if !state.origin_policy.same_origin(&headers) {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    let proxy_authenticated = state.trust_proxy_headers
        && headers
            .get("x-movie-harbor-proxy-token")
            .and_then(|value| value.to_str().ok())
            .zip(state.trusted_proxy_secret_digest.as_deref())
            .is_some_and(|(provided, expected)| csrf::digest(provided) == expected);
    let client_ip = if proxy_authenticated {
        headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.contains(','))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or_else(|| address.ip())
    } else {
        address.ip()
    };
    let normalized_username = input.username.trim().to_lowercase();
    // 密码计算前按来源和归一化账号取得限流许可，超限时不继续查询或计算。
    let window = state.limits.for_login(client_ip, &normalized_username);
    let admission = window
        .admit(Instant::now())
        .await
        .ok_or(AuthError(StatusCode::TOO_MANY_REQUESTS))?;
    let viewer = viewer_user::Entity::find()
        .filter(viewer_user::Column::NormalizedUsername.eq(&normalized_username))
        .one(&state.db)
        .await?;
    // 未知账号也验证固定摘要，使不存在账号的失败路径仍执行同等成本的密码计算。
    let verified_hash = viewer
        .as_ref()
        .map(|viewer| viewer.password_hash.as_str())
        .unwrap_or(UNKNOWN_USER_HASH)
        .to_owned();
    let password_ok =
        password::verify_limited(&state.password_work, input.password, verified_hash.clone())
            .await?;
    if !password_ok || viewer.is_none() {
        let limited = admission.failure(Instant::now()).await;
        return Err(AuthError(if limited {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::UNAUTHORIZED
        }));
    }
    let viewer = viewer.unwrap();
    let tx = state.db.begin().await?;
    // 密码计算完成后再加锁并重读，避免重置密码或删除用户期间创建旧快照会话。
    let viewer = viewer_user::Entity::find_by_id(viewer.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    if viewer.password_hash != verified_hash || viewer.normalized_username != normalized_username {
        admission.failure(Instant::now()).await;
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let mut model: viewer_user::ActiveModel = viewer.into();
    model.last_login_at = Set(Some(chrono::Utc::now().fixed_offset()));
    let viewer = model.update(&tx).await?;
    // 更新登录时间与创建会话同事务提交；失败时不会返回可用登录凭据。
    let raw = session::create(&tx, &viewer).await?;
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
        Json(serde_json::json!({"username":viewer.username})),
    )
        .into_response())
}

// 返回当前普通用户会话，供会话查询请求调用。
async fn read_session(Extension(current): Extension<session::CurrentSession>) -> Response {
    Json(SessionResponse {
        username: current.viewer.username,
        csrf_token: current.csrf_token,
    })
    .into_response()
}

// 撤销当前普通用户会话，供退出登录请求调用。
async fn logout(
    State(state): State<AuthState>,
    Extension(current): Extension<session::CurrentSession>,
) -> Result<Response, AuthError> {
    viewer_session::Entity::delete_by_id(current.session.id)
        .exec(&state.db)
        .await?;
    // A delayed response must not clear a newer login's cookie from another tab.
    // The revoked token has no authority; the next login replaces the stale cookie.
    Ok(StatusCode::NO_CONTENT.into_response())
}

// 修改普通用户密码并撤销全部会话，供改密请求调用。
async fn change_password(
    State(state): State<AuthState>,
    Extension(current): Extension<session::CurrentSession>,
    headers: HeaderMap,
    Json(input): Json<PasswordRequest>,
) -> Result<Response, AuthError> {
    if let Err(error) = password_policy::validate(&input.new_password) {
        return Ok(error.into_response());
    }
    let viewer = viewer_user::Entity::find_by_id(current.viewer.id)
        .one(&state.db)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    let verified_hash = viewer.password_hash.clone();
    // 已有会话仍需验证旧密码；密码不匹配时返回 400 并停止，校验出错则直接传播错误。
    if !password::verify_limited(
        &state.password_work,
        input.current_password,
        verified_hash.clone(),
    )
    .await?
    {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"当前密码不正确"})),
        )
            .into_response());
    }
    // 在开启事务和获取行锁之前计算新哈希，缩短锁持有时间；计算失败不会进入写入阶段。
    let hash = password::hash_limited(&state.password_work, input.new_password).await?;
    let tx = state.db.begin().await?;
    let viewer = viewer_user::Entity::find_by_id(current.viewer.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    // 前一次改密可能已撤销会话；在用户锁内重新验证会话和已校验的密码摘要。
    let locked_current = session::authenticate(&tx, &headers).await?;
    if locked_current.session.id != current.session.id || viewer.password_hash != verified_hash {
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let next_version = viewer.version + 1;
    let mut model: viewer_user::ActiveModel = viewer.into();
    model.password_hash = Set(hash);
    model.version = Set(next_version);
    model.updated_at = Set(chrono::Utc::now().fixed_offset());
    model.update(&tx).await?;
    // 与密码更新同事务撤销全部会话，提交后旧凭据不能继续使用。
    viewer_session::Entity::delete_many()
        .filter(viewer_session::Column::ViewerUserId.eq(current.viewer.id))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    // Session revocation is authoritative; do not overwrite a concurrent login cookie.
    Ok(StatusCode::NO_CONTENT.into_response())
}
