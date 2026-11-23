use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    routing::post,
};
use movie_harbor_api::admin_content::dto::BulkActionRequest;
use serde_json::{Value, json};
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
