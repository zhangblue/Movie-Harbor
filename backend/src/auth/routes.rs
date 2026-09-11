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

/// Apply this middleware to every authenticated management route, including future domain writes.
pub async fn require_session(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    let current = session::authenticate(&state.db, request.headers()).await?;
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        session::authorize_write(&current, request.headers(), &state.public_origin)?;
    }
    request.extensions_mut().insert(current);
    let mut response = next.run(request).await;
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
    if !csrf::same_origin(&headers, &state.public_origin) {
        return Err(AuthError(StatusCode::FORBIDDEN));
    }
    let window = state.limits.for_login(address.ip(), &input.name);
    if window.blocked(Instant::now()).await {
        return Err(AuthError(StatusCode::TOO_MANY_REQUESTS));
    }
    let admin = admin_user::Entity::find()
        .one(&state.db)
        .await?
        .ok_or(AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    // Always run Argon2, including unknown names, to avoid account-dependent fast failures.
    let verified_hash = admin.password_hash.clone();
    let password_ok =
        password::verify_limited(&state.password_work, input.password, verified_hash.clone())
            .await?;
    if !password_ok || input.name != admin.name {
        let limited = window.failure(Instant::now()).await;
        return Err(AuthError(if limited {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::UNAUTHORIZED
        }));
    }
    let tx = state.db.begin().await?;
    let admin = admin_user::Entity::find_by_id(admin.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    if admin.password_hash != verified_hash || input.name != admin.name {
        window.failure(Instant::now()).await;
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let raw = session::create(&tx, &admin).await?;
    tx.commit().await?;
    window.success().await;
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
    if input.new_password.trim().is_empty() {
        return Err(AuthError(StatusCode::BAD_REQUEST));
    }
    let admin = admin_user::Entity::find_by_id(current.admin.id)
        .one(&state.db)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    let verified_hash = admin.password_hash.clone();
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
    let tx = state.db.begin().await?;
    let admin = admin_user::Entity::find_by_id(current.admin.id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(AuthError(StatusCode::UNAUTHORIZED))?;
    // A preceding password change may have revoked this session while work happened outside the transaction.
    session::authenticate(&tx, &headers).await?;
    if admin.password_hash != verified_hash {
        return Err(AuthError(StatusCode::UNAUTHORIZED));
    }
    let mut model: admin_user::ActiveModel = admin.into();
    model.password_hash = Set(hash);
    model.updated_at = Set(chrono::Utc::now().fixed_offset());
    model.update(&tx).await?;
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
