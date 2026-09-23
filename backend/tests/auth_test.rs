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
    config::Config,
    entities::{admin_session, admin_user},
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    IntoActiveModel, QuerySelect, Set, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;
mod support;

fn config() -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: "/tmp/media".into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn database() -> DatabaseConnection {
    let url =
        std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required for auth tests");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("auth_test_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut opts = ConnectOptions::new(url);
    opts.set_schema_search_path(schema);
    let db = Database::connect(opts).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
    db
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
) -> Response {
    request_from(
        app,
        method,
        path,
        body,
        (cookie, csrf, origin),
        ("127.0.0.1:12345", None, false),
    )
    .await
}

async fn request_from(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    auth: (Option<&str>, Option<&str>, Option<&str>),
    connection: (&str, Option<&str>, bool),
) -> Response {
    let (cookie, csrf, origin) = auth;
    let (address, forwarded_for, authenticate_proxy) = connection;
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json");
    if let Some(value) = cookie {
        req = req.header("cookie", value);
    }
    if let Some(value) = csrf {
        req = req.header("x-csrf-token", value);
    }
    if let Some(value) = origin {
        req = req.header("origin", value);
    }
    if let Some(value) = forwarded_for {
        req = req.header("x-forwarded-for", value);
    }
    if authenticate_proxy {
        req = req.header(
            "x-movie-harbor-proxy-token",
            "test-proxy-secret-at-least-32-bytes",
        );
    }
    let mut req = req.body(Body::from(body.to_string())).unwrap();
    req.extensions_mut().insert(ConnectInfo(
        address.parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(req).await.unwrap()
}

// Catches Argon2 verification running while an exclusive administrator-row lock and pooled
// connection are held. Unknown-name work must finish while an unrelated writer owns the row.
#[tokio::test]
async fn invalid_logins_do_not_wait_for_the_administrator_row_lock() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let lock = db.begin().await.unwrap();
    admin_user::Entity::find()
        .lock_exclusive()
        .one(&lock)
        .await
        .unwrap();

    let attempts = (1..=3).map(|suffix| {
        let app = app.clone();
        tokio::spawn(async move {
            request_from(
                &app,
                "POST",
                "/api/admin/login",
                json!({"name":format!("Missing-{suffix}"),"password":"wrong"}),
                (None, None, Some("https://harbor.test")),
                (&format!("127.0.0.{suffix}:12345"), None, false),
            )
            .await
            .status()
        })
    });
    let statuses = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut statuses = Vec::new();
        for attempt in attempts {
            statuses.push(attempt.await.unwrap());
        }
        statuses
    })
    .await
    .expect("invalid logins waited on a row lock");
    assert_eq!(statuses, vec![StatusCode::UNAUTHORIZED; 3]);
    lock.rollback().await.unwrap();
}

// Catches a login minting a session from a hash that changed while Argon2 was verifying it.
#[tokio::test]
async fn login_never_accepts_an_old_hash_changed_during_verification() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let replacement =
        match movie_harbor_api::auth::password::hash("replacement-password".into()).await {
            Ok(hash) => hash,
            Err(_) => panic!("replacement password hashing failed"),
        };
    let login_app = app.clone();
    let pending = tokio::spawn(async move { login(&login_app, "Admin", "initial-password").await });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let admin = admin_user::Entity::find().one(&db).await.unwrap().unwrap();
    let mut changed = admin.into_active_model();
    changed.password_hash = Set(replacement);
    changed.update(&db).await.unwrap();
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        0
    );
}

#[tokio::test]
async fn forwarded_client_ip_is_used_only_when_the_proxy_mode_is_explicitly_trusted() {
    async fn forwarded(app: &Router, ip: &str, name: &str, authenticated: bool) -> StatusCode {
        request_from(
            app,
            "POST",
            "/api/admin/login",
            json!({"name":name,"password":"wrong"}),
            (None, None, Some("https://harbor.test")),
            ("172.20.0.5:12345", Some(ip), authenticated),
        )
        .await
        .status()
    }
    let db = database().await;
    let mut cfg = config();
    cfg.trust_proxy_headers = true;
    cfg.trusted_proxy_secret = Some("test-proxy-secret-at-least-32-bytes".into());
    let app = app::build(db, &cfg).await.unwrap();
    for _ in 0..5 {
        assert_eq!(
            forwarded(&app, "198.51.100.1", "Missing", true).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        forwarded(&app, "198.51.100.1", "Missing", true).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        forwarded(&app, "198.51.100.2", "Other", true).await,
        StatusCode::UNAUTHORIZED
    );

    let db = database().await;
    let mut cfg = config();
    cfg.trust_proxy_headers = true;
    cfg.trusted_proxy_secret = Some("test-proxy-secret-at-least-32-bytes".into());
    let app = app::build(db, &cfg).await.unwrap();
    for suffix in 1..=5 {
        assert_eq!(
            forwarded(
                &app,
                &format!("198.51.100.{suffix}"),
                &format!("Unauthenticated-{suffix}"),
                false,
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        forwarded(&app, "198.51.100.99", "Unauthenticated-last", false).await,
        StatusCode::TOO_MANY_REQUESTS
    );

    let db = database().await;
    let app = app::build(db, &config()).await.unwrap();
    for suffix in 1..=5 {
        assert_eq!(
            forwarded(
                &app,
                &format!("198.51.100.{suffix}"),
                &format!("Missing-{suffix}"),
                false,
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        forwarded(&app, "198.51.100.99", "Another", false).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn login(app: &Router, name: &str, password: &str) -> Response {
    request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":name,"password":password}),
        None,
        None,
        Some("https://harbor.test"),
    )
    .await
}

async fn credentials(app: &Router) -> (String, String) {
    let response = login(app, "Admin", "initial-password").await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let session = request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(session.status(), StatusCode::OK);
    let session = body(session).await;
    assert_eq!(session["name"], "Admin");
    (cookie, session["csrf_token"].as_str().unwrap().to_string())
}

// Catches missing initialization, replacement on restart, and startup unnecessarily requiring credentials.
#[tokio::test]
async fn initialization_is_required_once_and_never_overwrites_the_admin() {
    let db = database().await;
    let mut absent = config();
    absent.admin_name = None;
    absent.admin_initial_password = None;
    assert!(app::build(db.clone(), &absent).await.is_err());
    let _app = app::build(db.clone(), &config()).await.unwrap();
    let before = admin_user::Entity::find().all(&db).await.unwrap();
    assert_eq!(before.len(), 1);
    assert!(before[0].password_hash.starts_with("$argon2id$"));
    let _app = app::build(db.clone(), &absent).await.unwrap();
    let mut changed = config();
    changed.admin_name = Some("Replacement".into());
    changed.admin_initial_password = Some("other-password".into());
    let app = app::build(db.clone(), &changed).await.unwrap();
    assert_eq!(admin_user::Entity::find().all(&db).await.unwrap(), before);
    assert_eq!(
        login(&app, "Admin", "initial-password").await.status(),
        StatusCode::OK
    );
}

// Catches leaked plaintext session/CSRF storage, weak cookies, and nonrecoverable session tokens on restart.
#[tokio::test]
async fn login_issues_secure_opaque_session_and_recovers_csrf_after_restart() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let response = login(&app, "Admin", "initial-password").await;
    assert_eq!(response.status(), StatusCode::OK);
    let header = response.headers()["set-cookie"].to_str().unwrap();
    for flag in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/admin"] {
        assert!(header.contains(flag), "missing {flag}");
    }
    let (cookie, csrf) = credentials(&app).await;
    let raw = cookie.split_once('=').unwrap().1;
    assert_eq!(raw.len(), 64);
    let sessions = admin_session::Entity::find().all(&db).await.unwrap();
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0].token_hash, sessions[1].token_hash);
    use sha2::{Digest, Sha256};
    let expected_token_hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let expected_csrf_hash = format!("{:x}", Sha256::digest(csrf.as_bytes()));
    assert!(
        sessions
            .iter()
            .any(|session| session.token_hash == expected_token_hash
                && session.csrf_token_hash == expected_csrf_hash)
    );
    for session in sessions {
        assert_eq!(session.token_hash.len(), 64);
        assert_ne!(session.token_hash, raw);
        assert_ne!(session.csrf_token_hash, csrf);
    }
    let restarted = app::build(db.clone(), &config()).await.unwrap();
    let response = request(
        &restarted,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(body(response).await["csrf_token"], csrf);
}

// Catches account enumeration and off-by-one throttling.
#[tokio::test]
async fn login_errors_are_indistinguishable_and_sixth_failure_is_limited() {
    let app = app::build(database().await, &config()).await.unwrap();
    let unknown = login(&app, "Missing", "wrong").await;
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let known = login(&app, "Admin", "wrong").await;
    assert_eq!(known.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body(unknown).await, body(known).await);
    for _ in 2..5 {
        assert_eq!(
            login(&app, "Admin", "wrong").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        login(&app, "Admin", "wrong").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login(&app, "Admin", "initial-password").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    // Advance only the monotonic application clock, then resume normal I/O before using PostgreSQL.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(900)).await;
    tokio::time::resume();
    assert_eq!(
        login(&app, "Admin", "initial-password").await.status(),
        StatusCode::OK
    );
}

// Catches authentication failures being cached by a browser or intermediary.
#[tokio::test]
async fn every_sensitive_auth_failure_is_no_store() {
    let database = support::TestDatabase::migrated("auth_no_store").await;
    let app = app::build(database.connection(), &config()).await.unwrap();
    let responses = [
        login(&app, "Missing", "wrong").await,
        request(
            &app,
            "GET",
            "/api/admin/session",
            json!(null),
            None,
            None,
            None,
        )
        .await,
        request(
            &app,
            "POST",
            "/api/admin/password",
            json!({"current_password":"wrong","new_password":"new"}),
            None,
            None,
            Some("https://harbor.test"),
        )
        .await,
    ];
    for response in responses {
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
    }
}

// Catches writes bypassing either authorization, CSRF, or same-origin checks.
#[tokio::test]
async fn protected_writes_require_session_csrf_and_same_origin() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    for path in ["/api/admin/logout", "/api/admin/password"] {
        let payload = json!({"current_password":"initial-password", "new_password":"new-password"});
        for (c, t, o, status) in [
            (
                None,
                Some(csrf.as_str()),
                Some("https://harbor.test"),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Some(cookie.as_str()),
                None,
                Some("https://harbor.test"),
                StatusCode::FORBIDDEN,
            ),
            (
                Some(cookie.as_str()),
                Some("wrong"),
                Some("https://harbor.test"),
                StatusCode::FORBIDDEN,
            ),
            (
                Some(cookie.as_str()),
                Some(csrf.as_str()),
                Some("https://evil.test"),
                StatusCode::FORBIDDEN,
            ),
            (
                Some(cookie.as_str()),
                Some(csrf.as_str()),
                Some("http://harbor.test"),
                StatusCode::FORBIDDEN,
            ),
            (
                Some(cookie.as_str()),
                Some(csrf.as_str()),
                None,
                StatusCode::FORBIDDEN,
            ),
        ] {
            assert_eq!(
                request(&app, "POST", path, payload.clone(), c, t, o)
                    .await
                    .status(),
                status
            );
        }
    }
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        1
    );
}

// Catches password changes without checking the current password or without revoking other devices.
#[tokio::test]
async fn password_change_checks_current_password_and_revokes_all_sessions() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let (other, _) = credentials(&app).await;
    let previous = admin_user::Entity::find()
        .one(&db)
        .await
        .unwrap()
        .unwrap()
        .password_hash;
    let bad = request(
        &app,
        "POST",
        "/api/admin/password",
        json!({"current_password":"wrong","new_password":"new-password"}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        2
    );
    let changed = request(
        &app,
        "POST",
        "/api/admin/password",
        json!({"current_password":"initial-password","new_password":"new-password"}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        0
    );
    for cookie in [&cookie, &other] {
        assert_eq!(
            request(
                &app,
                "GET",
                "/api/admin/session",
                json!(null),
                Some(cookie),
                None,
                None
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let current = admin_user::Entity::find()
        .one(&db)
        .await
        .unwrap()
        .unwrap()
        .password_hash;
    assert_ne!(
        argon2::PasswordHash::new(&previous).unwrap().salt,
        argon2::PasswordHash::new(&current).unwrap().salt
    );
    assert_eq!(
        login(&app, "Admin", "initial-password").await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, "Admin", "new-password").await.status(),
        StatusCode::OK
    );
}

// Catches expired cookies remaining usable and logout not removing server-side state.
#[tokio::test]
async fn logout_and_expiry_reject_reuse() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let response = request(
        &app,
        "POST",
        "/api/admin/logout",
        json!({}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
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
        request(
            &app,
            "GET",
            "/api/admin/session",
            json!(null),
            Some(&cookie),
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let (cookie, _) = credentials(&app).await;
    db.execute_unprepared(
        "UPDATE admin_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'",
    )
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/session",
            json!(null),
            Some(&cookie),
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

// Catches accepting an empty replacement password and revoking valid sessions on rejected input.
#[tokio::test]
async fn empty_replacement_password_is_rejected_without_mutating_authentication() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let before = admin_user::Entity::find().all(&db).await.unwrap();
    let response = request(
        &app,
        "POST",
        "/api/admin/password",
        json!({"current_password":"initial-password","new_password":""}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(admin_user::Entity::find().all(&db).await.unwrap(), before);
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        1
    );
}

// Catches simultaneous empty-table bootstraps creating multiple administrators.
#[tokio::test]
async fn concurrent_startup_creates_only_one_administrator() {
    let db = database().await;
    let config = config();
    let (first, second) = tokio::join!(
        app::build(db.clone(), &config),
        app::build(db.clone(), &config)
    );
    assert!(first.is_ok() && second.is_ok());
    assert_eq!(admin_user::Entity::find().all(&db).await.unwrap().len(), 1);
}

// Catches initialization incorrectly accepting a missing or blank bootstrap value on an empty table.
#[tokio::test]
async fn empty_database_reports_each_missing_initialization_credential() {
    let db = database().await;
    for (name, password, missing) in [
        (None, Some("password"), "ADMIN_NAME"),
        (Some("Admin"), None, "ADMIN_INITIAL_PASSWORD"),
        (Some(" "), Some("password"), "ADMIN_NAME"),
        (Some("Admin"), Some(" "), "ADMIN_INITIAL_PASSWORD"),
    ] {
        let mut config = config();
        config.admin_name = name.map(str::to_string);
        config.admin_initial_password = password.map(str::to_string);
        let error = match app::build(db.clone(), &config).await {
            Err(error) => error,
            Ok(_) => panic!("missing initialization credential accepted"),
        };
        assert!(error.to_string().contains(missing));
    }
    assert!(
        admin_user::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .is_empty()
    );
}

// Catches accepting a forged Host/Origin pair that is not in trusted deployment configuration.
#[tokio::test]
async fn matching_but_unconfigured_host_and_origin_are_rejected() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    for path in [
        "/api/admin/login",
        "/api/admin/logout",
        "/api/admin/password",
    ] {
        let mut req = Request::builder().method("POST").uri(path)
            .header("host", "unconfigured.test").header("origin", "https://unconfigured.test")
            .header("forwarded", "host=harbor.test;proto=https")
            .header("x-forwarded-host", "harbor.test")
            .header("content-type", "application/json").header("cookie", &cookie).header("x-csrf-token", &csrf)
            .body(Body::from(json!({"name":"Admin","password":"initial-password","current_password":"initial-password","new_password":"replacement"}).to_string())).unwrap();
        req.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
        ));
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "unconfigured origin accepted on {path}"
        );
    }
    assert_eq!(
        admin_session::Entity::find().all(&db).await.unwrap().len(),
        1
    );
}

// Catches literal-string origin comparisons that reject equivalent case/default-port forms.
#[tokio::test]
async fn configured_origin_normalizes_scheme_host_and_default_port() {
    let mut cfg = config();
    cfg.public_origin = "HTTPS://HARBOR.TEST:443/".into();
    let app = app::build(database().await, &cfg).await.unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/login",
            json!({"name":"Admin","password":"initial-password"}),
            None,
            None,
            Some("https://HARBOR.TEST:443")
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/login",
            json!({"name":"Admin","password":"initial-password"}),
            None,
            None,
            Some("https://harbor.test:444")
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
}

// Catches callers bypassing environment parsing to start a production app with insecure cookies.
#[tokio::test]
async fn app_startup_rejects_insecure_non_loopback_configuration() {
    let mut cfg = config();
    cfg.cookie_secure = false;
    assert!(app::build(database().await, &cfg).await.is_err());
}

// Catches local HTTP development passing config parsing but failing at the actual login boundary.
#[tokio::test]
async fn loopback_development_login_can_issue_an_http_cookie() {
    let mut cfg = config();
    cfg.public_origin = "http://localhost:5173".into();
    cfg.cookie_secure = false;
    let app = app::build(database().await, &cfg).await.unwrap();
    let mut req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header("host", "LOCALHOST:5173")
        .header("origin", "http://localhost:5173")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"name":"Admin","password":"initial-password"}).to_string(),
        ))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(
        !cookie
            .split(';')
            .any(|attribute| attribute.trim() == "Secure")
    );
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
}
