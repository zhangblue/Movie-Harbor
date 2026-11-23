mod support;

use axum::{
    Json, Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
    routing::post,
};
use http_body_util::BodyExt;
use movie_harbor_api::admin_content::{
    dto::BulkActionRequest,
    service::{BulkActionError, execute_bulk_action},
};
use movie_harbor_api::{app, config::Config};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use support::TestDatabase;
use tower::ServiceExt;

/// 在契约测试路由中解析批量请求，隔离验证 DTO 而不提前引入数据库服务。
async fn parse_bulk(Json(value): Json<Value>) -> StatusCode {
    if BulkActionRequest::from_value(value).is_ok() {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    }
}

/// 向契约测试路由提交 JSON，返回解析状态供输入边界断言。
async fn submit(value: Value) -> StatusCode {
    Router::new()
        .route("/bulk", post(parse_bulk))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/bulk")
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

/// 持有批量路由测试的临时媒体目录，并在测试结束时删除。
struct TempRoot(PathBuf);

impl TempRoot {
    /// 创建测试专属媒体根目录，避免应用启动恢复逻辑接触其他测试数据。
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_bulk_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempRoot {
    /// 测试结束时尽力清理临时媒体目录。
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 构造启用安全 Cookie 和同源校验的应用配置，供批量路由认证测试使用。
fn config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        mcp_api_key_digest: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

/// 发送带测试远端地址的应用请求，使认证限速和来源中间件获得完整上下文。
async fn app_request(
    app: &Router,
    method: &str,
    uri: &str,
    value: Value,
    auth: Option<(&str, Option<&str>)>,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("content-type", "application/json");
    if let Some((cookie, csrf)) = auth {
        builder = builder.header("cookie", cookie);
        if let Some(csrf) = csrf {
            builder = builder.header("x-csrf-token", csrf);
        }
    }
    let mut request = builder.body(Body::from(value.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

/// 读取 JSON 响应体，供登录凭据和批量错误结构断言使用。
async fn response_json(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// 登录预置管理员并返回会话 Cookie 与 CSRF token，供受保护写路由测试使用。
async fn credentials(app: &Router) -> (String, String) {
    let response = app_request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        None,
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
    let session = app_request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some((&cookie, None)),
    )
    .await;
    assert_eq!(session.status(), StatusCode::OK);
    let csrf = response_json(session).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    (cookie, csrf)
}

/// 构造一条合法电影目标，供批量输入组合测试复用。
fn movie_target(index: u128) -> Value {
    json!({"kind":"movie","id":format!("10000000-0000-0000-0000-{index:012}"),"version":1})
}

#[tokio::test]
/// 验证三种判别动作只接受各自字段并接受合法目标。
async fn bulk_request_accepts_only_well_formed_discriminated_actions() {
    let target = movie_target(1);
    for request in [
        json!({"action":"set_privacy","is_private":true,"targets":[target.clone()]}),
        json!({"action":"update_genres","mode":"add","genre_ids":["30000000-0000-0000-0000-000000000001"],"targets":[target.clone()]}),
        json!({"action":"archive","targets":[target.clone()]}),
    ] {
        assert_eq!(submit(request).await, StatusCode::OK);
    }
    assert_eq!(
        submit(json!({"action":"archive","is_private":true,"targets":[target]})).await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
/// 验证目标数量、唯一性、类型、标识和正版本在解析阶段被严格限制。
async fn bulk_request_rejects_invalid_targets() {
    let valid = movie_target(1);
    let too_many = (1..=21).map(movie_target).collect::<Vec<_>>();
    let invalid = [
        json!({"action":"archive","targets":[]}),
        json!({"action":"archive","targets":too_many}),
        json!({"action":"archive","targets":[valid.clone(), valid.clone()]}),
        json!({"action":"archive","targets":[{"kind":"episode","id":"10000000-0000-0000-0000-000000000001","version":1}]}),
        json!({"action":"archive","targets":[{"kind":"movie","id":"not-a-uuid","version":1}]}),
        json!({"action":"archive","targets":[{"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":0}]}),
    ];
    for request in invalid {
        assert_eq!(submit(request).await, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
/// 验证题材动作要求单一合法模式和一至二十个唯一 UUID。
async fn bulk_request_rejects_invalid_genres() {
    let target = movie_target(1);
    let genres = (1..=21)
        .map(|index| format!("30000000-0000-0000-0000-{index:012}"))
        .collect::<Vec<_>>();
    let invalid = [
        json!({"action":"update_genres","mode":"add","genre_ids":[],"targets":[target.clone()]}),
        json!({"action":"update_genres","mode":"add","genre_ids":genres,"targets":[target.clone()]}),
        json!({"action":"update_genres","mode":"add","genre_ids":["30000000-0000-0000-0000-000000000001","30000000-0000-0000-0000-000000000001"],"targets":[target.clone()]}),
        json!({"action":"update_genres","mode":"replace","genre_ids":["30000000-0000-0000-0000-000000000001"],"targets":[target.clone()]}),
        json!({"action":"update_genres","mode":"remove","genre_ids":["invalid"],"targets":[target]}),
    ];
    for request in invalid {
        assert_eq!(submit(request).await, StatusCode::BAD_REQUEST);
    }
}

/// 准备包含不同状态、题材启用状态和既有关联的真实 PostgreSQL 数据，供原子批量测试复用。
async fn seeded_database(prefix: &str) -> TestDatabase {
    let db = TestDatabase::migrated(prefix).await;
    db.execute_unprepared(
        r#"
INSERT INTO genre (id, name, enabled, sort_order) VALUES
('30000000-0000-0000-0000-000000000001', 'Action', true, 1),
('30000000-0000-0000-0000-000000000002', 'Retired', false, 2);
INSERT INTO movie (id, name, is_private, status, version, published_at) VALUES
('10000000-0000-0000-0000-000000000001', 'Published movie', false, 'published', 1, now()),
('10000000-0000-0000-0000-000000000002', 'Draft movie', false, 'draft', 2, NULL);
INSERT INTO series (id, name, is_private, status, version, published_at) VALUES
('20000000-0000-0000-0000-000000000001', 'Published series', false, 'published', 1, now()),
('20000000-0000-0000-0000-000000000002', 'Draft series', false, 'draft', 2, NULL);
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002');
"#,
    )
    .await
    .unwrap();
    db
}

/// 从 JSON 构造已校验请求，使服务测试继续覆盖与 HTTP 相同的输入边界。
fn action(value: Value) -> BulkActionRequest {
    BulkActionRequest::from_value(value).unwrap()
}

/// 查询单个内容的版本和隐私值，供原子提交与回滚断言使用。
async fn movie_state(db: &TestDatabase, id: &str) -> (i64, bool, String) {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT version, is_private, status FROM movie WHERE id = $1::uuid",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    (
        row.try_get("", "version").unwrap(),
        row.try_get("", "is_private").unwrap(),
        row.try_get("", "status").unwrap(),
    )
}

#[tokio::test]
/// 验证电影和剧集可在单事务中成功修改隐私，重复提交因旧版本整体失败。
async fn bulk_service_updates_mixed_targets_once_and_rejects_replay() {
    let db = seeded_database("bulk_mixed").await;
    let request = action(json!({
        "action":"set_privacy","is_private":true,
        "targets":[
            {"kind":"series","id":"20000000-0000-0000-0000-000000000001","version":1},
            {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1}
        ]
    }));
    let response = execute_bulk_action(&db, request.clone()).await.unwrap();
    assert_eq!(response.results.len(), 2);
    assert!(response.results.iter().all(|result| result.version == 2));
    assert!(response.results.iter().all(|result| result.is_private));
    assert_eq!(
        movie_state(&db, "10000000-0000-0000-0000-000000000001").await,
        (2, true, "published".into())
    );

    let error = execute_bulk_action(&db, request).await.unwrap_err();
    assert!(matches!(error, BulkActionError::Validation(problems) if problems.len() == 2));
    assert_eq!(
        movie_state(&db, "10000000-0000-0000-0000-000000000001")
            .await
            .0,
        2
    );
}

#[tokio::test]
/// 验证服务一次收集不存在、旧版本和题材问题，并在任何问题存在时保持零写入。
async fn bulk_service_collects_complete_problem_set_and_rolls_back() {
    let db = seeded_database("bulk_problems").await;
    let error = execute_bulk_action(
        &db,
        action(json!({
            "action":"update_genres","mode":"add",
            "genre_ids":[
                "30000000-0000-0000-0000-000000000002",
                "30000000-0000-0000-0000-000000000099"
            ],
            "targets":[
                {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":99},
                {"kind":"series","id":"20000000-0000-0000-0000-000000000099","version":1}
            ]
        })),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, BulkActionError::Validation(problems) if problems.len() == 4));
    assert_eq!(
        movie_state(&db, "10000000-0000-0000-0000-000000000001")
            .await
            .0,
        1
    );

    let invalid_state = execute_bulk_action(
        &db,
        action(json!({"action":"archive","targets":[
            {"kind":"movie","id":"10000000-0000-0000-0000-000000000002","version":2}
        ]})),
    )
    .await
    .unwrap_err();
    assert!(matches!(invalid_state, BulkActionError::Validation(problems) if problems.len() == 1));
}

#[tokio::test]
/// 验证停用题材不可添加但可移除，且无效果的移除仍只递增一次目标版本。
async fn bulk_service_applies_genre_rules_and_bumps_noop_once() {
    let db = seeded_database("bulk_genres").await;
    let inactive_add = execute_bulk_action(
        &db,
        action(json!({"action":"update_genres","mode":"add","genre_ids":["30000000-0000-0000-0000-000000000002"],"targets":[
            {"kind":"series","id":"20000000-0000-0000-0000-000000000001","version":1}
        ]})),
    )
    .await;
    assert!(matches!(inactive_add, Err(BulkActionError::Validation(_))));

    let removed = execute_bulk_action(
        &db,
        action(json!({"action":"update_genres","mode":"remove","genre_ids":["30000000-0000-0000-0000-000000000002"],"targets":[
            {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1},
            {"kind":"series","id":"20000000-0000-0000-0000-000000000001","version":1}
        ]})),
    )
    .await
    .unwrap();
    assert!(removed.results.iter().all(|result| result.version == 2));
    assert!(
        removed
            .results
            .iter()
            .all(|result| result.genres.is_empty())
    );
}

#[tokio::test]
/// 验证目标顺序相反的并发请求按统一顺序取锁，不死锁且只有一个请求提交。
async fn bulk_service_serializes_reverse_order_requests_without_deadlock() {
    let db = seeded_database("bulk_concurrent").await;
    let first = action(json!({"action":"set_privacy","is_private":true,"targets":[
        {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1},
        {"kind":"series","id":"20000000-0000-0000-0000-000000000001","version":1}
    ]}));
    let second = action(json!({"action":"set_privacy","is_private":false,"targets":[
        {"kind":"series","id":"20000000-0000-0000-0000-000000000001","version":1},
        {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1}
    ]}));
    let db_one = db.connection();
    let db_two = db.connection();
    let outcomes = tokio::time::timeout(Duration::from_secs(5), async move {
        tokio::join!(
            execute_bulk_action(&db_one, first),
            execute_bulk_action(&db_two, second)
        )
    })
    .await
    .expect("逆序批量请求不应死锁");
    assert_eq!(
        usize::from(outcomes.0.is_ok()) + usize::from(outcomes.1.is_ok()),
        1
    );
}

#[tokio::test]
/// 验证批量归档只接受已发布内容并写入归档状态和单次版本递增。
async fn bulk_service_archives_published_content() {
    let db = seeded_database("bulk_archive").await;
    let response = execute_bulk_action(
        &db,
        action(json!({"action":"archive","targets":[
            {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1}
        ]})),
    )
    .await
    .unwrap();
    assert_eq!(response.results[0].status, "archived");
    assert_eq!(
        movie_state(&db, "10000000-0000-0000-0000-000000000001").await,
        (2, false, "archived".into())
    );
}

#[tokio::test]
/// 验证批量路由沿用管理员会话、同源和 CSRF 防护，并返回服务成功摘要。
async fn bulk_route_requires_admin_csrf_and_executes_once() {
    let db = seeded_database("bulk_route").await;
    let root = TempRoot::new();
    let app = app::build(db.connection(), &config(&root.0)).await.unwrap();
    let payload = json!({"action":"set_privacy","is_private":true,"targets":[
        {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","version":1}
    ]});
    assert_eq!(
        app_request(
            &app,
            "POST",
            "/api/admin/contents/bulk-actions",
            payload.clone(),
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = credentials(&app).await;
    assert_eq!(
        app_request(
            &app,
            "POST",
            "/api/admin/contents/bulk-actions",
            payload.clone(),
            Some((&cookie, None))
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let response = app_request(
        &app,
        "POST",
        "/api/admin/contents/bulk-actions",
        payload,
        Some((&cookie, Some(&csrf))),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["results"][0]["version"], 2);
}
