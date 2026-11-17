use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    auth::{self, AuthState, csrf::OriginPolicy},
    entities::{admin_user, viewer_user},
    site_agent, viewer_auth,
};
use sea_orm::{ConnectionTrait, EntityTrait};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

mod support;

// 在真实 PostgreSQL 上验证归属约束和会话隔离，以及管理员跨账号读取历史。
#[tokio::test]
async fn agent_turns_are_owned_and_auditable() {
    let db = support::TestDatabase::migrated("agent_turns").await;
    db.execute_unprepared(
        r#"
        INSERT INTO admin_user (id, name, password_hash) VALUES
          ('00000000-0000-0000-0000-000000000001', 'Admin', 'unused');
        INSERT INTO viewer_user (id, username, normalized_username, password_hash) VALUES
          ('00000000-0000-0000-0000-000000000001', 'Alice', 'alice', 'unused'),
          ('00000000-0000-0000-0000-000000000002', 'Bob', 'bob', 'unused');
        INSERT INTO agent_turn (admin_id, prompt, reply) VALUES
          ('00000000-0000-0000-0000-000000000001', 'admin question', 'admin answer');
        INSERT INTO agent_turn (viewer_id, prompt, reply) VALUES
          ('00000000-0000-0000-0000-000000000001', 'alice question', 'alice answer'),
          ('00000000-0000-0000-0000-000000000002', 'bob question', 'bob answer');
    "#,
    )
    .await
    .unwrap();
    assert!(
        db.execute_unprepared("INSERT INTO agent_turn (prompt, reply) VALUES ('orphan', 'reply')")
            .await
            .is_err()
    );
    let admin = admin_user::Entity::find().one(&*db).await.unwrap().unwrap();
    let alice = viewer_user::Entity::find_by_id(admin.id)
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    let alice_token = viewer_auth::session::create(&*db, &alice)
        .await
        .ok()
        .unwrap();
    let admin_token = auth::session::create(&*db, &admin).await.ok().unwrap();
    let app = site_agent::router(AuthState {
        db: db.connection(),
        cookie_secure: false,
        origin_policy: OriginPolicy::new("http://localhost:8080".parse().unwrap(), false),
        trust_proxy_headers: false,
        trusted_proxy_secret_digest: None,
        mcp_api_key_digest: None,
        limits: Default::default(),
        password_work: Arc::new(tokio::sync::Semaphore::new(2)),
    })
    .unwrap();

    let alice_cookie = format!("mh_viewer_session={alice_token}");
    let admin_cookie = format!("mh_session={admin_token}");
    let (status, result) = read(&app, "/api/viewer/agent/history", &alice_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["prompt"], "alice question");
    let (status, _) = read(&app, "/api/admin/agent/audit", &alice_cookie).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, result) = read(&app, "/api/admin/agent/history", &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["prompt"], "admin question");
    let (status, result) = read(&app, "/api/admin/agent/audit", &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["items"].as_array().unwrap().len(), 3);

    // 同一 UUID 可以出现在两种账号中，聚合和查询必须同时区分角色。
    let accounts_path = "/api/admin/agent/audit/accounts";
    let (status, _) = read(&app, accounts_path, &alice_cookie).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, accounts) = read(&app, accounts_path, &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accounts.as_array().unwrap().len(), 3);
    assert_eq!(accounts[0]["account"], "Bob");
    assert_eq!(accounts[1]["account"], "Alice");
    assert_eq!(accounts[2]["account"], "Admin");
    assert_eq!(accounts[1]["id"], accounts[2]["id"]);
    assert_eq!(accounts[1]["account_role"], "viewer");
    assert_eq!(accounts[1]["turn_count"], 1);
    assert_eq!(accounts[2]["account_role"], "admin");

    let alice_history = format!(
        "/api/admin/agent/audit?account_id={}&account_role=viewer",
        alice.id
    );
    let (status, result) = read(&app, &alice_history, &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["prompt"], "alice question");

    let (status, _) = read(
        &app,
        "/api/admin/agent/audit?account_role=viewer",
        &admin_cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 模拟浏览器 UTC+08:00 的日期边界，验证结束日完整包含、账号隔离及筛选后分页。
    db.execute_unprepared(
        r#"
        INSERT INTO agent_turn (viewer_id, prompt, reply, created_at) VALUES
          ('00000000-0000-0000-0000-000000000001', 'before range', 'reply', '2000-11-15T15:59:59Z'),
          ('00000000-0000-0000-0000-000000000001', 'inclusive start', 'reply', '2000-11-15T16:00:00Z'),
          ('00000000-0000-0000-0000-000000000001', 'exclusive end', 'reply', '2000-11-16T16:00:00Z'),
          ('00000000-0000-0000-0000-000000000002', 'another viewer', 'reply', '2000-11-16T10:00:00Z');
        INSERT INTO agent_turn (viewer_id, prompt, reply, created_at)
          SELECT '00000000-0000-0000-0000-000000000001', 'inside range', 'reply', '2000-11-16T15:59:59Z'
          FROM generate_series(1, 20);
        "#,
    )
    .await
    .unwrap();
    let filtered =
        format!("{alice_history}&start_at=2000-11-15T16:00:00Z&end_before=2000-11-16T16:00:00Z");
    let (status, page) = read(&app, &filtered, &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 21);
    assert_eq!(page["items"].as_array().unwrap().len(), 20);
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["prompt"] == "inside range")
    );
    let next = page["next"].as_str().unwrap();
    let (status, page) = read(&app, &format!("{filtered}&before={next}"), &admin_cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 21);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["prompt"], "inclusive start");
    assert!(page["next"].is_null());

    let (status, page) = read(
        &app,
        &format!("{alice_history}&end_before=2000-11-15T16:00:00Z"),
        &admin_cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["prompt"], "before range");
    let (status, _) = read(
        &app,
        &format!("{alice_history}&start_at=2000-11-17T00:00:00Z&end_before=2000-11-16T00:00:00Z"),
        &admin_cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// 通过真实路由读取历史，业务拒绝时保留状态用于断言。
async fn read(router: &Router, uri: &str, cookie: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::get(uri)
                .header("host", "localhost:8080")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
