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
    auth::{csrf, mcp},
    config::Config,
};
use serde_json::{Value, json};
use tower::ServiceExt;
mod support;

const KEY: &str = "mcp-test-key-never-log-this";
const ID: &str = "00000000-0000-4000-8000-000000000001";

// Catches omitting an approved operation or accepting lookalike/invalid UUID paths.
#[test]
fn mcp_route_policy_is_an_exact_method_and_path_allowlist() {
    let allowed = [
        ("GET", "/api/admin/contents"),
        ("GET", "/api/admin/genres"),
        ("GET", "/api/admin/movies"),
        (
            "GET",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001",
        ),
        ("GET", "/api/admin/series"),
        (
            "GET",
            "/api/admin/series/00000000-0000-4000-8000-000000000001",
        ),
        (
            "GET",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons/00000000-0000-4000-8000-000000000001/episodes/00000000-0000-4000-8000-000000000001",
        ),
        ("POST", "/api/admin/genres"),
        ("POST", "/api/admin/media/posters/stage"),
        ("POST", "/api/admin/movies"),
        (
            "POST",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001/publish",
        ),
        ("POST", "/api/admin/series"),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/publish",
        ),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons",
        ),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons/00000000-0000-4000-8000-000000000001/episodes",
        ),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons/00000000-0000-4000-8000-000000000001/episodes/00000000-0000-4000-8000-000000000001/publish",
        ),
        (
            "POST",
            "/api/admin/media/movies/00000000-0000-4000-8000-000000000001/video",
        ),
        (
            "POST",
            "/api/admin/media/episodes/00000000-0000-4000-8000-000000000001/video",
        ),
        (
            "PATCH",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001",
        ),
        (
            "PATCH",
            "/api/admin/series/00000000-0000-4000-8000-000000000001",
        ),
        (
            "PATCH",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons/00000000-0000-4000-8000-000000000001/episodes/00000000-0000-4000-8000-000000000001",
        ),
    ];
    for (method, path) in allowed {
        assert!(
            mcp::route_allowed(&method.parse().unwrap(), path),
            "{method} {path}"
        );
    }
    for (method, path) in [
        ("HEAD", "/api/admin/genres"),
        ("OPTIONS", "/api/admin/genres"),
        ("PUT", "/api/admin/genres"),
        ("DELETE", "/api/admin/genres"),
        ("GET", "/api/admin/genres/"),
        ("GET", "/api/admin/genres/anything"),
        ("GET", "/api/admin/movies/not-a-uuid"),
        (
            "POST",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001/archive",
        ),
        (
            "POST",
            "/api/admin/media/movies/00000000-0000-4000-8000-000000000001/poster",
        ),
        (
            "PATCH",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/seasons/00000000-0000-4000-8000-000000000001",
        ),
        ("GET", "/api/admin/contents/export"),
        ("GET", "/api/admin/session"),
    ] {
        assert!(
            !mcp::route_allowed(&method.parse().unwrap(), path),
            "{method} {path}"
        );
    }
}

async fn setup(enabled: bool) -> (support::TestDatabase, Router, std::path::PathBuf) {
    let db = support::TestDatabase::migrated("mcp_auth_test").await;
    let root = std::env::temp_dir().join(format!("mcp_auth_{}", uuid::Uuid::new_v4()));
    let config = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.clone(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        mcp_api_key_digest: enabled.then(|| csrf::digest(KEY)),
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    };
    let router = app::build(db.connection(), &config).await.unwrap();
    (db, router, root)
}

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let mut request = request.body(Body::from(body.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

// Catches omission of the Bearer branch and accidentally retaining CSRF on MCP writes.
#[tokio::test]
async fn bearer_can_query_and_create_genres_without_cookie_csrf_or_origin() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    let headers = [("host", "harbor.test"), ("authorization", bearer.as_str())];
    let response = send(&app, "GET", "/api/admin/genres", json!(null), &headers).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(body(response).await.as_array().unwrap().len(), 12);
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/genres?probe=1",
            json!(null),
            &headers
        )
        .await
        .status(),
        StatusCode::OK
    );
    let response = send(
        &app,
        "POST",
        "/api/admin/genres",
        json!({"name":"MCP genre"}),
        &headers,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(body(response).await["name"], "MCP genre");
    std::fs::remove_dir_all(root).unwrap();
}

// Catches widening an allowed prefix into account management or destructive permissions.
#[tokio::test]
async fn bearer_denies_every_unlisted_management_operation() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    let headers = [("host", "harbor.test"), ("authorization", bearer.as_str())];
    for (method, path) in [
        ("DELETE", format!("/api/admin/genres/{ID}")),
        ("PATCH", format!("/api/admin/genres/{ID}")),
        ("PUT", "/api/admin/genres/order".into()),
        ("POST", format!("/api/admin/genres/{ID}/deactivate")),
        ("GET", "/api/admin/contents/export".into()),
        ("POST", "/api/admin/password".into()),
        ("GET", "/api/admin/session".into()),
        ("POST", "/api/admin/logout".into()),
        ("GET", "/api/admin/users".into()),
        ("HEAD", "/api/admin/genres".into()),
        ("PUT", format!("/api/admin/movies/{ID}/privacy")),
        ("DELETE", format!("/api/admin/movies/{ID}")),
        ("POST", format!("/api/admin/movies/{ID}/archive")),
        ("POST", format!("/api/admin/movies/{ID}/draft")),
        ("GET", format!("/api/admin/movies/{ID}/delete-impact")),
        ("POST", format!("/api/admin/media/movies/{ID}/poster")),
        ("POST", format!("/api/admin/media/series/{ID}/poster")),
        ("PATCH", format!("/api/admin/series/{ID}/seasons/{ID}")),
        ("GET", "/api/viewer/session".into()),
    ] {
        assert_eq!(
            send(&app, method, &path, json!({}), &headers)
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

// Catches treating an absent key, ambiguous Authorization, or another scheme as MCP.
#[tokio::test]
async fn disabled_wrong_and_ambiguous_bearer_credentials_are_rejected() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    for authorization in [
        "Bearer wrong",
        "Basic abc",
        "Bearer ",
        "Bearer",
        "Bearer a b",
        "Bearer a,b",
        "bearer wrong",
    ] {
        assert_eq!(
            send(
                &app,
                "GET",
                "/api/admin/genres",
                json!(null),
                &[("host", "harbor.test"), ("authorization", authorization)]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/genres",
            json!(null),
            &[
                ("host", "harbor.test"),
                ("authorization", &bearer),
                ("authorization", &bearer)
            ]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    std::fs::remove_dir_all(root).unwrap();
    let (_db, app, root) = setup(false).await;
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/genres",
            json!(null),
            &[("host", "harbor.test"), ("authorization", &bearer)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    std::fs::remove_dir_all(root).unwrap();
}

// Catches moving Bearer authentication ahead of the existing Host policy.
#[tokio::test]
async fn bearer_never_bypasses_host_validation() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    for host in ["evil.test", "harbor.test:444", "harbor.test@evil.test"] {
        assert_eq!(
            send(
                &app,
                "GET",
                "/api/admin/genres",
                json!(null),
                &[("host", host), ("authorization", &bearer)]
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/genres",
            json!(null),
            &[
                ("host", "harbor.test"),
                ("host", "harbor.test"),
                ("authorization", &bearer)
            ]
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/genres",
            json!(null),
            &[("authorization", &bearer)]
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    std::fs::remove_dir_all(root).unwrap();
}

// Catches breaking CurrentSession extraction or suppressing Cookie CSRF on failed MCP attempts.
#[tokio::test]
async fn administrator_cookie_retains_session_and_csrf_including_bearer_fallback() {
    let (_db, app, root) = setup(true).await;
    let response = send(
        &app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        &[("host", "harbor.test"), ("origin", "https://harbor.test")],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let response = send(
        &app,
        "GET",
        "/api/admin/session",
        json!(null),
        &[("host", "harbor.test"), ("cookie", &cookie)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let csrf = body(response).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    let bearer = format!("Bearer {KEY}");
    // Valid MCP on a forbidden route still falls back to the existing admin cookie.
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/admin/contents/export",
            json!(null),
            &[
                ("host", "harbor.test"),
                ("cookie", &cookie),
                ("authorization", &bearer)
            ]
        )
        .await
        .status(),
        StatusCode::OK
    );
    for authorization in ["Bearer wrong", "Basic abc"] {
        assert_eq!(
            send(
                &app,
                "POST",
                "/api/admin/genres",
                json!({"name":"Forbidden"}),
                &[
                    ("host", "harbor.test"),
                    ("cookie", &cookie),
                    ("authorization", authorization)
                ]
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        send(
            &app,
            "POST",
            "/api/admin/genres",
            json!({"name":"Cookie genre"}),
            &[
                ("host", "harbor.test"),
                ("origin", "https://harbor.test"),
                ("cookie", &cookie),
                ("x-csrf-token", &csrf),
                ("authorization", "Bearer wrong")
            ]
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/api/admin/logout",
            json!({}),
            &[
                ("host", "harbor.test"),
                ("origin", "https://harbor.test"),
                ("cookie", &cookie),
                ("x-csrf-token", &csrf),
                ("authorization", &bearer)
            ]
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    std::fs::remove_dir_all(root).unwrap();
}
