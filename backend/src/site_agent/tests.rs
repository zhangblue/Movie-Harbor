use super::*;
use axum::{extract::State, routing::post};
use tokio::{net::TcpListener, sync::Mutex};

#[path = "../../tests/support/mod.rs"]
mod support;

// 根据队列返回模型工具调用，并记录收到的每次请求，供测试核对外发内容。
async fn model(
    State(calls): State<Arc<Mutex<Vec<Value>>>>,
    Json(request): Json<Value>,
) -> Json<Value> {
    let mut calls = calls.lock().await;
    let last = request["messages"].as_array().unwrap().last().unwrap();
    if last["role"] == "tool" {
        assert_eq!(last["tool_call_id"], "call_test");
        let lists: Value = serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
        let public = lists["public"].as_array().map(Vec::len);
        let private = lists["private"].as_array().map(Vec::len);
        let reply = match (public, private) {
            (Some(public), Some(private)) => format!(
                "合计 {} 部，公开 {public} 部，私密 {private} 部。",
                public + private
            ),
            (Some(public), None) => format!("公开 {public} 部。"),
            (None, Some(private)) => format!("私密 {private} 部。"),
            _ => panic!("名称工具须返回一个或两个名称数组"),
        };
        calls.push(request);
        return Json(json!({"choices":[{"message":{"content": reply}}]}));
    }
    let (name, arguments) = match calls.len() {
        0 => ("search_content", json!({"name":"验收"})),
        1 => ("list_content", json!({})),
        2 => ("content_details", json!({"name":"验收私片"})),
        3 => ("series_counts", json!({"name":"验收私剧"})),
        4 => ("list_content", json!({"private_only":true})),
        5 => ("search_content", json!({"name":"验收"})),
        6 => ("list_content_names", json!({"privacy":"private"})),
        8 => (
            "list_content_names",
            json!({"privacy":"public","kind":"movie"}),
        ),
        10 => ("list_content_names", json!({})),
        12 => (
            "list_content_names",
            json!({"privacy":"public","kind":"series"}),
        ),
        14 => (
            "list_content_names",
            json!({"privacy":"private","kind":"series"}),
        ),
        _ => panic!("片库查询结果不应触发额外的模型请求"),
    };
    calls.push(request);
    Json(json!({"choices":[{"message":{
        "content":null,
        "tool_calls":[{"id":"call_test","function":{"name":name,"arguments":arguments.to_string()}}]
    }}]}))
}

// 使用隔离数据库和回环模型服务，验证本地查询、名称工具的外发范围以及历史脱敏。
#[tokio::test]
async fn catalog_names_are_shared_only_for_the_requested_tool() {
    let db = support::TestDatabase::migrated("agent_private_catalog").await;
    db.execute_unprepared(
        r#"
INSERT INTO viewer_user (id, username, normalized_username, password_hash) VALUES
('69500000-0000-0000-0000-000000000001', 'Viewer', 'viewer', 'unused');
INSERT INTO admin_user (id, name, password_hash) VALUES
('69500000-0000-0000-0000-000000000002', 'Admin', 'unused');
INSERT INTO movie (id, name, synopsis, is_private, status, published_at) VALUES
('69000000-0000-0000-0000-000000000001', '验收公片', '公开简介', false, 'published', '2026-01-01'),
('69000000-0000-0000-0000-000000000002', '验收私片', '仅限本机的私密简介', true, 'published', '2026-01-02'),
('69000000-0000-0000-0000-000000000003', '验收私密草稿', '', true, 'draft', NULL),
('69000000-0000-0000-0000-000000000004', '验收已归档', '', true, 'archived', '2026-01-03');
INSERT INTO series (id, name, synopsis, is_private, status, published_at) VALUES
('69100000-0000-0000-0000-000000000001', '验收私剧', '', true, 'published', '2026-01-02');
INSERT INTO season (id, series_id, number) VALUES
('69200000-0000-0000-0000-000000000001', '69100000-0000-0000-0000-000000000001', 1);
INSERT INTO episode (id, season_id, number, name, status, published_at) VALUES
('69300000-0000-0000-0000-000000000001', '69200000-0000-0000-0000-000000000001', 1, '已发布单集', 'published', '2026-01-01'),
('69300000-0000-0000-0000-000000000002', '69200000-0000-0000-0000-000000000001', 2, '草稿单集', 'draft', NULL);
"#,
    )
    .await
    .unwrap();

    let calls = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/chat", post(model))
        .with_state(calls.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let state = AgentState {
        db: db.connection(),
        client: reqwest::Client::new(),
        api_key: Some(Arc::from("test-key")),
        capacity: Arc::new(Semaphore::new(1)),
        model_endpoint: Some(endpoint),
    };
    let viewer = Owner::Viewer("69500000-0000-0000-0000-000000000001".parse().unwrap());
    let admin = Owner::Admin("69500000-0000-0000-0000-000000000002".parse().unwrap());

    // 连续调用让测试同时覆盖第一次工具调用与后续历史重放。
    for (owner, prompt, expected, excluded) in [
        (viewer, "搜索影片", "验收私片", "验收私密草稿"),
        (viewer, "显示片库", "验收公片", "验收已归档"),
        (viewer, "影片详情", "仅限本机的私密简介", "验收私密草稿"),
        (viewer, "季集数", "共 1 季，1 集", "草稿单集"),
        (viewer, "只看私密片单", "验收私剧", "验收公片"),
        (admin, "后台搜索", "验收私密草稿", "仅限本机的私密简介"),
    ] {
        let response = chat(
            &state,
            owner,
            ChatRequest {
                message: prompt.to_owned(),
            },
        )
        .await
        .unwrap();
        assert!(response.reply.contains(expected), "{}", response.reply);
        assert!(!response.reply.contains(excluded), "{}", response.reply);
    }
    let saved = history(&db, Some(viewer), None, 20).await.unwrap();
    assert!(saved.items[2].reply.contains("仅限本机的私密简介"));
    assert!(
        serde_json::to_value(saved).unwrap()["items"][2]
            .get("model_reply")
            .is_none()
    );
    for (owner, prompt, expected) in [
        (viewer, "私密影片有多少部？", "私密 2 部。"),
        (viewer, "公开电影有多少部？", "公开 1 部。"),
        (
            viewer,
            "公开和私密影片分别有多少部？",
            "合计 3 部，公开 1 部，私密 2 部。",
        ),
        (viewer, "公开剧集有多少部？", "公开 0 部。"),
        (admin, "私密剧集有多少部？", "私密 1 部。"),
    ] {
        let response = chat(
            &state,
            owner,
            ChatRequest {
                message: prompt.to_owned(),
            },
        )
        .await
        .unwrap();
        assert_eq!(response.reply, expected);
    }
    let calls = calls.lock().await;
    assert_eq!(calls.len(), 16);
    assert!(
        calls[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "list_content_names")
    );
    let expected_lists = [
        (7, json!({"private":["验收私剧","验收私片"]})),
        (9, json!({"public":["验收公片"]})),
        (
            11,
            json!({"public":["验收公片"],"private":["验收私剧","验收私片"]}),
        ),
        (13, json!({"public":[]})),
        (15, json!({"private":["验收私剧"]})),
    ];
    for (index, request) in calls.iter().enumerate() {
        let messages = request["messages"].as_array().unwrap();
        let mut context = messages.as_slice();
        if let Some((_, expected)) = expected_lists
            .iter()
            .find(|(expected_index, _)| *expected_index == index)
        {
            let tool = messages.last().unwrap();
            assert_eq!(tool["role"], "tool");
            let mut actual: Value =
                serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
            // 数据库排序规则可以不同，比较前在测试中统一两个名称的顺序。
            if let Some(names) = actual.get_mut("private").and_then(Value::as_array_mut) {
                names.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            assert_eq!(&actual, expected);
            context = &messages[..messages.len() - 1];
        }
        let payload = serde_json::to_string(context).unwrap();
        for secret in [
            "验收私片",
            "验收私剧",
            "仅限本机的私密简介",
            "私密 2 部",
            "69000000-0000-0000-0000-000000000002",
        ] {
            assert!(!payload.contains(secret), "模型请求包含片库资料 {secret}");
        }
    }
    assert!(calls[2].to_string().contains("page=1"));
    drop(calls);
    // 明确请求私密片单时，后端直接按权限查库，不依赖模型选择工具或补齐筛选参数。
    let local_only = AgentState {
        api_key: None,
        ..state
    };
    for (owner, prompt, include_series) in [
        (viewer, "请列出私密影片。", true),
        (admin, "私密电影列表", false),
        (viewer, "有哪些私密电影？", false),
    ] {
        let response = chat(
            &local_only,
            owner,
            ChatRequest {
                message: prompt.to_owned(),
            },
        )
        .await;
        let reply = response
            .map_err(|status| status.to_string())
            .unwrap()
            .0
            .reply;
        assert!(reply.contains("验收私片"));
        assert_eq!(reply.contains("验收私剧"), include_series);
        assert!(!reply.contains("验收公片"));
        assert!(!reply.contains("验收私密草稿"));
    }
    let response = chat(
        &local_only,
        viewer,
        ChatRequest {
            message: "有多少部私密影片？".to_owned(),
        },
    )
    .await;
    assert_eq!(response.err(), Some(StatusCode::SERVICE_UNAVAILABLE));

    server.abort();
}
