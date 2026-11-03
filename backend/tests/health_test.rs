use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// 验证健康检查请求返回成功状态和固定 JSON 响应体。
#[tokio::test]
async fn health_returns_ok() {
    let response = movie_harbor_api::app::test_router()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), br#"{"status":"ok"}"#);
}
