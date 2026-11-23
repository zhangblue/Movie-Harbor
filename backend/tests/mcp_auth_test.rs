use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
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
/// 验证 MCP 路由策略只允许明确列出的请求方法与路径。
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
        (
            "POST",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001/archive",
        ),
        (
            "POST",
            "/api/admin/movies/00000000-0000-4000-8000-000000000001/draft",
        ),
        ("POST", "/api/admin/series"),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/publish",
        ),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/archive",
        ),
        (
            "POST",
            "/api/admin/series/00000000-0000-4000-8000-000000000001/draft",
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
            "/api/admin/media/episodes/00000000-0000-4000-8000-000000000001/poster",
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

#[test]
/// 验证 MCP 白名单只接纳合法电影和整剧的访问范围修改。
fn route_allowed_for_visibility() {
    for content in ["movies", "series"] {
        let path = format!("/api/admin/{content}/{ID}/privacy");
        assert!(mcp::route_allowed(&Method::PUT, &path));
        for method in [Method::POST, Method::DELETE] {
            assert!(!mcp::route_allowed(&method, &path), "{method} {path}");
        }
        assert!(!mcp::route_allowed(
            &Method::PUT,
            &format!("/api/admin/{content}/not-a-uuid/privacy"),
        ));
        assert!(!mcp::route_allowed(&Method::PUT, &format!("{path}/extra"),));
    }
}

#[test]
/// 验证海报白名单只接纳电影、整剧和合法 UUID 的精确 POST 路径。
fn route_allowed_for_content_poster() {
    for content in ["movies", "series"] {
        let path = format!("/api/admin/media/{content}/{ID}/poster");
        assert!(mcp::route_allowed(&Method::POST, &path), "{path}");
        for method in [Method::GET, Method::PUT, Method::PATCH, Method::DELETE] {
            assert!(!mcp::route_allowed(&method, &path), "{method} {path}");
        }
        for path in [
            format!("/api/admin/media/{content}/not-a-uuid/poster"),
            format!("{path}/"),
            format!("{path}/extra"),
        ] {
            assert!(!mcp::route_allowed(&Method::POST, &path), "{path}");
        }
    }
}

#[test]
/// 验证单集状态转换的请求必须匹配动作和全部层级标识。
fn route_allowed_for_episode_lifecycle() {
    let episode = format!("/api/admin/series/{ID}/seasons/{ID}/episodes/{ID}");
    assert!(!mcp::route_allowed(
        &Method::PUT,
        &format!("{episode}/privacy"),
    ));
    for action in ["publish", "archive", "draft"] {
        let path = format!("{episode}/{action}");
        assert!(mcp::route_allowed(&Method::POST, &path));
        assert!(!mcp::route_allowed(&Method::DELETE, &path));
        assert!(!mcp::route_allowed(&Method::POST, &format!("{path}/extra"),));
        for (series, season, episode) in [("bad", ID, ID), (ID, "bad", ID), (ID, ID, "bad")] {
            assert!(!mcp::route_allowed(
                &Method::POST,
                &format!("/api/admin/series/{series}/seasons/{season}/episodes/{episode}/{action}"),
            ));
        }
    }
}

/// 在测试准备阶段创建隔离数据库、应用和场景所需凭据。
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

/// 在 MCP 认证测试中构造并发送指定请求。
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

/// 在断言响应内容时读取并解析 JSON 响应体。
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

// Catches omission of the Bearer branch and accidentally retaining CSRF on MCP writes.
#[tokio::test]
/// 验证有效 Bearer 凭据无需 Cookie、CSRF 或来源即可查询和创建题材。
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
/// 验证 Bearer 凭据不能访问白名单以外的管理操作。
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
        (
            "DELETE",
            format!("/api/admin/series/{ID}/seasons/{ID}/episodes/{ID}"),
        ),
        ("DELETE", format!("/api/admin/movies/{ID}")),
        ("GET", format!("/api/admin/movies/{ID}/delete-impact")),
        ("POST", "/api/admin/media/movies/not-a-uuid/poster".into()),
        ("POST", "/api/admin/media/series/not-a-uuid/poster".into()),
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

// Catches allowing the route matcher but rejecting the Bearer principal before existing lifecycle handlers run.
#[tokio::test]
/// 验证 Bearer 凭据可进入维护工具复用的访问范围和生命周期接口。
async fn bearer_can_reach_visibility_and_lifecycle_routes() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    let headers = [("host", "harbor.test"), ("authorization", bearer.as_str())];
    let episode = format!("/api/admin/series/{ID}/seasons/{ID}/episodes/{ID}");
    for (method, path) in [
        ("PUT", format!("/api/admin/movies/{ID}/privacy")),
        ("PUT", format!("/api/admin/series/{ID}/privacy")),
        ("POST", format!("/api/admin/movies/{ID}/archive")),
        ("POST", format!("/api/admin/movies/{ID}/draft")),
        ("POST", format!("/api/admin/series/{ID}/archive")),
        ("POST", format!("/api/admin/series/{ID}/draft")),
        ("POST", format!("{episode}/publish")),
        ("POST", format!("{episode}/archive")),
        ("POST", format!("{episode}/draft")),
    ] {
        // 缺少版本时应在通过授权后由请求提取返回 422；若白名单遗漏则会提前返回 401。
        assert_eq!(
            send(&app, method, &path, json!({}), &headers)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{method} {path}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
/// 验证合法 Bearer 能到达两个海报上传端点的 Multipart 校验。
async fn bearer_can_reach_content_poster_upload_routes() {
    let (_db, app, root) = setup(true).await;
    let bearer = format!("Bearer {KEY}");
    let headers = [("host", "harbor.test"), ("authorization", bearer.as_str())];
    for content in ["movies", "series"] {
        let path = format!("/api/admin/media/{content}/{ID}/poster?version=1");
        // 请求体缺少 Multipart 边界，通过鉴权后应由媒体路由返回 400。
        assert_eq!(
            send(&app, "POST", &path, json!({}), &headers)
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

// Catches treating an absent key, ambiguous Authorization, or another scheme as MCP.
#[tokio::test]
/// 验证禁用、错误和歧义 Bearer 凭据均被拒绝。
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
/// 验证 Bearer 凭据不能绕过 Host 校验。
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
/// 验证管理员 Cookie 及 Bearer 回退路径仍执行会话和 CSRF 校验。
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
