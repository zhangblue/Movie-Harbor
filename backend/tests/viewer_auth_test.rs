use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    app,
    auth::password,
    config::Config,
    entities::{admin_session, viewer_session, viewer_user},
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel, QuerySelect, Set,
    Statement, TransactionTrait,
};
use serde_json::{Value, json};
use tower::ServiceExt;
mod support;

// Catches optional authentication granting privileges from a duplicate or malformed Cookie header.
#[tokio::test]
async fn optional_viewer_authentication_treats_invalid_cookies_as_anonymous() {
    let (db, app, _) = setup().await;
    let (cookie, _) = credentials(&app).await;
    for value in [
        None,
        Some("mh_session=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        Some("mh_viewer_session=bad"),
        Some("mh_viewer_session=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    ] {
        let mut headers = axum::http::HeaderMap::new();
        if let Some(value) = value {
            headers.insert("cookie", value.parse().unwrap());
        }
        assert!(
            movie_harbor_api::viewer_auth::session::authenticate_optional(&*db, &headers)
                .await
                .ok()
                .unwrap()
                .is_none()
        );
    }
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("cookie", cookie.parse().unwrap());
    assert!(
        movie_harbor_api::viewer_auth::session::authenticate_optional(&*db, &headers)
            .await
            .ok()
            .unwrap()
            .is_some()
    );
    headers.append("cookie", cookie.parse().unwrap());
    assert!(
        movie_harbor_api::viewer_auth::session::authenticate_optional(&*db, &headers)
            .await
            .ok()
            .unwrap()
            .is_none()
    );
    headers.remove("cookie");
    headers.insert("cookie", cookie.parse().unwrap());
    headers.append(
        "cookie",
        axum::http::HeaderValue::from_bytes(&[0xff]).unwrap(),
    );
    assert!(
        movie_harbor_api::viewer_auth::session::authenticate_optional(&*db, &headers)
            .await
            .ok()
            .unwrap()
            .is_none()
    );
    headers.remove("cookie");
    headers.insert("cookie", cookie.parse().unwrap());
    db.execute_unprepared(
        "UPDATE viewer_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'",
    )
    .await
    .unwrap();
    assert!(
        movie_harbor_api::viewer_auth::session::authenticate_optional(&*db, &headers)
            .await
            .ok()
            .unwrap()
            .is_none()
    );
}

async fn setup() -> (support::TestDatabase, Router, viewer_user::Model) {
    let db = support::TestDatabase::migrated("viewer_auth").await;
    let hash = password::hash("viewer-password".into()).await.ok().unwrap();
    let user = viewer_user::ActiveModel {
        id: Set(uuid::Uuid::new_v4()),
        username: Set("Summer".into()),
        normalized_username: Set("summer".into()),
        password_hash: Set(hash),
        ..Default::default()
    }
    .insert(&*db)
    .await
    .unwrap();
    let cfg = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: "/tmp/media".into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Summer".into()),
        admin_initial_password: Some("admin-password".into()),
    };
    let app = app::build(db.connection(), &cfg).await.unwrap();
    (db, app, user)
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    auth: (Option<&str>, Option<&str>, Option<&str>),
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json");
    for (name, value) in [
        ("cookie", auth.0),
        ("x-csrf-token", auth.1),
        ("origin", auth.2),
    ] {
        if let Some(value) = value {
            builder = builder.header(name, value);
        }
    }
    let mut req = builder.body(Body::from(payload.to_string())).unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(req).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn login(app: &Router, username: &str, password: &str) -> Response {
    request(
        app,
        "POST",
        "/api/viewer/login",
        json!({"username":username,"password":password}),
        (None, None, Some("https://harbor.test")),
    )
    .await
}
async fn read(app: &Router, cookie: Option<&str>) -> Response {
    request(
        app,
        "GET",
        "/api/viewer/session",
        json!(null),
        (cookie, None, None),
    )
    .await
}
fn response_cookie(response: &Response) -> String {
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
async fn credentials(app: &Router) -> (String, String) {
    let response = login(app, " summer ", "viewer-password").await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response_cookie(&response);
    let session = read(app, Some(&cookie)).await;
    assert_eq!(session.status(), StatusCode::OK);
    let session = body(session).await;
    assert_eq!(session["username"], "Summer");
    (cookie, session["csrf_token"].as_str().unwrap().to_owned())
}

// Catches missing viewer routes, plaintext token storage and granting either identity the other's permissions.
#[tokio::test]
async fn viewer_cookie_login_is_normalized_opaque_and_independent_of_admin() {
    let (db, app, user) = setup().await;
    let response = login(&app, " SUMMER ", "viewer-password").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let header = response.headers()["set-cookie"].to_str().unwrap();
    for flag in [
        "mh_viewer_session=",
        "Path=/;",
        "HttpOnly",
        "SameSite=Lax",
        "Secure",
        "Max-Age=86400",
    ] {
        assert!(header.contains(flag), "missing {flag}");
    }
    let cookie = response_cookie(&response);
    assert_eq!(body(response).await, json!({"username":"Summer"}));
    let session = body(read(&app, Some(&cookie)).await).await;
    let raw = cookie.split_once('=').unwrap().1;
    let stored = viewer_session::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw.len(), 64);
    assert_ne!(stored.token_hash, raw);
    assert_ne!(
        stored.csrf_token_hash,
        session["csrf_token"].as_str().unwrap()
    );
    assert!(
        viewer_user::Entity::find_by_id(user.id)
            .one(&*db)
            .await
            .unwrap()
            .unwrap()
            .last_login_at
            .is_some()
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/session",
            json!(null),
            (Some(&cookie), None, None)
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let admin = request(
        &app,
        "POST",
        "/api/admin/login",
        json!({"name":"Summer","password":"admin-password"}),
        (None, None, Some("https://harbor.test")),
    )
    .await;
    assert_eq!(admin.status(), StatusCode::OK);
    assert_eq!(
        read(&app, Some(&response_cookie(&admin))).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        admin_session::Entity::find().all(&*db).await.unwrap().len(),
        1
    );
}

// Catches username enumeration and origin protection missing from the independent login entry point.
#[tokio::test]
async fn viewer_cookie_login_failures_are_uniform_and_origin_checked() {
    let (_db, app, _) = setup().await;
    let wrong = login(&app, "Summer", "wrong").await;
    let unknown = login(&app, "missing", "viewer-password").await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let wrong_body = body(wrong).await;
    assert_eq!(wrong_body, body(unknown).await);
    assert_eq!(wrong_body, json!({"error":"用户名或密码错误"}));
    for origin in [None, Some("https://evil.test")] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/viewer/login",
                json!({"username":"Summer","password":"viewer-password"}),
                (None, None, origin)
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
}

// Catches expired/malformed credentials being accepted and logout accidentally revoking all devices.
#[tokio::test]
async fn viewer_cookie_logout_revokes_current_session_and_expiry_rejects_reuse() {
    let (db, app, _) = setup().await;
    let (cookie, csrf) = credentials(&app).await;
    let (other, _) = credentials(&app).await;
    let response = request(
        &app,
        "POST",
        "/api/viewer/logout",
        json!({}),
        (Some(&cookie), Some(&csrf), Some("https://harbor.test")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(
        read(&app, Some(&cookie)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(read(&app, Some(&other)).await.status(), StatusCode::OK);
    db.execute_unprepared(
        "UPDATE viewer_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'",
    )
    .await
    .unwrap();
    for cookie in [
        None,
        Some(other.as_str()),
        Some("mh_viewer_session=bad"),
        Some("mh_viewer_session=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    ] {
        assert_eq!(read(&app, cookie).await.status(), StatusCode::UNAUTHORIZED);
    }
}

// Catches short self-service passwords mutating the hash/version or revoking a valid session.
#[tokio::test]
async fn viewer_self_password_change_requires_at_least_eight_characters() {
    let (db, app, user) = setup().await;
    let (cookie, csrf) = credentials(&app).await;
    for password in ["1234567", "😀😀😀😀😀😀😀"] {
        let response = request(
            &app,
            "PATCH",
            "/api/viewer/password",
            json!({"current_password":"viewer-password","new_password":password}),
            (Some(&cookie), Some(&csrf), Some("https://harbor.test")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body(response).await,
            json!({"error":"密码至少需要 8 个字符。"})
        );
        let unchanged = viewer_user::Entity::find_by_id(user.id)
            .one(&*db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.password_hash, user.password_hash);
        assert_eq!(unchanged.version, user.version);
        assert_eq!(read(&app, Some(&cookie)).await.status(), StatusCode::OK);
    }
    let mut current = "viewer-password";
    let mut cookie = cookie;
    let mut csrf = csrf;
    for password in ["12345678", "😀😀😀😀😀😀😀😀"] {
        let response = request(
            &app,
            "PATCH",
            "/api/viewer/password",
            json!({"current_password":current,"new_password":password}),
            (Some(&cookie), Some(&csrf), Some("https://harbor.test")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            read(&app, Some(&cookie)).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let logged_in = login(&app, "Summer", password).await;
        assert_eq!(logged_in.status(), StatusCode::OK);
        cookie = response_cookie(&logged_in);
        csrf = body(read(&app, Some(&cookie)).await).await["csrf_token"]
            .as_str()
            .unwrap()
            .to_owned();
        current = password;
    }
}

// Catches missing CSRF, wrong current-password checks, incomplete revocation or password/version update.
#[tokio::test]
async fn viewer_cookie_password_change_verifies_origin_csrf_and_revokes_all_devices() {
    let (db, app, user) = setup().await;
    let (cookie, csrf) = credentials(&app).await;
    let (other, _) = credentials(&app).await;
    let payload =
        json!({"current_password":"viewer-password","new_password":"replacement-password"});
    for (csrf, origin) in [
        (None, Some("https://harbor.test")),
        (Some("wrong"), Some("https://harbor.test")),
        (Some(csrf.as_str()), None),
        (Some(csrf.as_str()), Some("https://evil.test")),
    ] {
        for (method, path) in [
            ("PATCH", "/api/viewer/password"),
            ("POST", "/api/viewer/logout"),
        ] {
            assert_eq!(
                request(
                    &app,
                    method,
                    path,
                    payload.clone(),
                    (Some(&cookie), csrf, origin)
                )
                .await
                .status(),
                StatusCode::FORBIDDEN
            );
        }
    }
    for (current, new, status) in [
        ("wrong", "replacement", StatusCode::UNAUTHORIZED),
        ("viewer-password", "  ", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            request(
                &app,
                "PATCH",
                "/api/viewer/password",
                json!({"current_password":current,"new_password":new}),
                (Some(&cookie), Some(&csrf), Some("https://harbor.test"))
            )
            .await
            .status(),
            status
        );
    }
    assert_eq!(
        viewer_session::Entity::find()
            .all(&*db)
            .await
            .unwrap()
            .len(),
        2
    );
    let response = request(
        &app,
        "PATCH",
        "/api/viewer/password",
        payload,
        (Some(&cookie), Some(&csrf), Some("https://harbor.test")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("mh_viewer_session=; Path=/;")
    );
    assert_eq!(
        viewer_session::Entity::find()
            .all(&*db)
            .await
            .unwrap()
            .len(),
        0
    );
    for cookie in [&cookie, &other] {
        assert_eq!(
            read(&app, Some(cookie)).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let updated = viewer_user::Entity::find_by_id(user.id)
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.version, user.version + 1);
    assert!(updated.updated_at > user.updated_at);
    assert_ne!(updated.password_hash, user.password_hash);
    assert_eq!(
        login(&app, "Summer", "viewer-password").await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, "Summer", "replacement-password").await.status(),
        StatusCode::OK
    );
}

// Catches login issuing a session using a password verified before a concurrent reset commits.
#[tokio::test]
async fn viewer_cookie_login_rechecks_password_after_waiting_for_user_lock() {
    let (db, app, user) = setup().await;
    let hash = password::hash("replacement-password".into())
        .await
        .ok()
        .unwrap();
    let tx = db.begin().await.unwrap();
    let locked = viewer_user::Entity::find_by_id(user.id)
        .lock_exclusive()
        .one(&tx)
        .await
        .unwrap()
        .unwrap();
    let pending = tokio::spawn(async move { login(&app, "Summer", "viewer-password").await });
    wait_for_row_lock_waiter(&db, &tx).await;
    let mut changed = locked.into_active_model();
    changed.password_hash = Set(hash);
    changed.update(&tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert!(
        viewer_session::Entity::find()
            .all(&*db)
            .await
            .unwrap()
            .is_empty()
    );
}

// Confirm the request reached its transaction lock rather than relying on Argon2 timing.
async fn wait_for_row_lock_waiter(
    db: &sea_orm::DatabaseConnection,
    tx: &sea_orm::DatabaseTransaction,
) {
    let xid: String = tx
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT pg_current_xact_id()::text AS xid".to_owned(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "xid")
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let count: i64 = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
                "SELECT COUNT(*) AS blocked FROM pg_locks WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = $1",
                [xid.clone().into()])).await.unwrap().unwrap().try_get("", "blocked").unwrap();
            if count > 0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("authentication request must wait for the locked viewer row");
}

// Catches a password change trusting a session revoked while its password work was in progress.
#[tokio::test]
async fn viewer_password_change_reauthenticates_session_inside_user_lock() {
    let (db, app, user) = setup().await;
    let (cookie, csrf) = credentials(&app).await;
    let tx = db.begin().await.unwrap();
    viewer_user::Entity::find_by_id(user.id)
        .lock_exclusive()
        .one(&tx)
        .await
        .unwrap()
        .unwrap();
    let pending = tokio::spawn(async move {
        request(
            &app,
            "PATCH",
            "/api/viewer/password",
            json!({"current_password":"viewer-password","new_password":"replacement-password"}),
            (Some(&cookie), Some(&csrf), Some("https://harbor.test")),
        )
        .await
    });
    wait_for_row_lock_waiter(&db, &tx).await;
    viewer_session::Entity::delete_many()
        .exec(&tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let unchanged = viewer_user::Entity::find_by_id(user.id)
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.password_hash, user.password_hash);
    assert_eq!(unchanged.version, user.version);
}
