use movie_harbor_api::site_agent::classify_tool;
use serde_json::json;

// 验证模型工具参数只允许公开范围查询和草稿提议。
#[test]
fn validates_tool_allowlist() {
    assert!(classify_tool("search_content", r#"{"name":"星际","privacy":"private"}"#).is_err());
    assert!(classify_tool("delete_movie", "{}").is_err());
    assert!(classify_tool("propose_draft", r#"{"kind":"episode","name":"测试"}"#).is_err());
    let tool = classify_tool("propose_draft", r#"{"kind":"movie","name":" 星际穿越 "}"#).unwrap();
    assert_eq!(
        serde_json::to_value(tool).unwrap()["name"],
        json!("星际穿越")
    );
}

// 验证聊天接口在解析请求或联系模型前拒绝匿名和仅持 MCP 密钥的调用。
#[tokio::test]
async fn chat_requires_browser_admin_session() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use movie_harbor_api::{
        auth::{AuthState, csrf::OriginPolicy, csrf::digest},
        site_agent,
    };
    use sea_orm::DatabaseConnection;
    use std::sync::Arc;
    use tower::ServiceExt;

    let key = "test-mcp-key";
    let router = site_agent::router(AuthState {
        db: DatabaseConnection::Disconnected,
        cookie_secure: false,
        origin_policy: OriginPolicy::new("http://localhost:8080".parse().unwrap(), false),
        trust_proxy_headers: false,
        trusted_proxy_secret_digest: None,
        mcp_api_key_digest: Some(digest(key)),
        limits: Default::default(),
        password_work: Arc::new(tokio::sync::Semaphore::new(2)),
    })
    .unwrap();

    for authorization in ["", "Bearer test-mcp-key"] {
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/admin/agent/chat")
                    .header("host", "localhost:8080")
                    .header("origin", "http://localhost:8080")
                    .header("authorization", authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

// 验证所有历史入口均先检查对应的会话。
#[tokio::test]
async fn history_routes_reject_anonymous_requests() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use movie_harbor_api::{
        auth::{AuthState, csrf::OriginPolicy},
        site_agent,
    };
    use sea_orm::DatabaseConnection;
    use std::sync::Arc;
    use tower::ServiceExt;
    let router = site_agent::router(AuthState {
        db: DatabaseConnection::Disconnected,
        cookie_secure: false,
        origin_policy: OriginPolicy::new("http://localhost:8080".parse().unwrap(), false),
        trust_proxy_headers: false,
        trusted_proxy_secret_digest: None,
        mcp_api_key_digest: None,
        limits: Default::default(),
        password_work: Arc::new(tokio::sync::Semaphore::new(2)),
    })
    .unwrap();
    for path in [
        "/api/viewer/agent/history",
        "/api/admin/agent/history",
        "/api/admin/agent/audit",
        "/api/admin/agent/audit/accounts",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::get(path)
                    .header("host", "localhost:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
}

// 验证新增查询工具接受分页和受控详情标识，拒绝越界参数与可见性覆盖。
#[test]
fn validates_catalog_tool_calls() {
    assert!(classify_tool("list_content", "{}").is_ok());
    assert!(classify_tool("list_content", r#"{"kind":"movie","page":2}"#).is_ok());
    assert!(classify_tool("list_content", r#"{"page":0}"#).is_err());
    assert!(classify_tool("list_content", r#"{"include_private":true}"#).is_err());
    assert!(
        classify_tool(
            "series_counts",
            r#"{"id":"00000000-0000-0000-0000-000000000001"}"#
        )
        .is_ok()
    );
    assert!(
        classify_tool(
            "content_details",
            r#"{"kind":"series","id":"00000000-0000-0000-0000-000000000001"}"#
        )
        .is_ok()
    );
    assert!(classify_tool("content_details", r#"{"kind":"all","id":"unknown"}"#).is_err());
}
