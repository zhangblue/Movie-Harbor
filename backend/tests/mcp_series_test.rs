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
    auth::csrf,
    config::Config,
    entities::{episode, season, series},
};
use sea_orm::{ActiveModelTrait, EntityTrait, PaginatorTrait, Set};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

mod support;

const KEY: &str = "mcp-series-test-key";

async fn setup() -> (support::TestDatabase, Router, std::path::PathBuf) {
    let db = support::TestDatabase::migrated("mcp_series").await;
    let root = std::env::temp_dir().join(format!("mcp_series_{}", Uuid::new_v4()));
    let config = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.clone(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        mcp_api_key_digest: Some(csrf::digest(KEY)),
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    };
    let app = app::build(db.connection(), &config).await.unwrap();
    (db, app, root)
}

async fn send(app: &Router, path: &str, payload: Value) -> Response {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "harbor.test")
        .header("authorization", format!("Bearer {KEY}"))
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn insert_series(db: &support::TestDatabase, status: &str, version: i64) -> series::Model {
    series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(format!("{status} series")),
        is_private: Set(true),
        synopsis: Set(String::new()),
        status: Set(status.into()),
        version: Set(version),
        ..Default::default()
    }
    .insert(&**db)
    .await
    .unwrap()
}

async fn insert_season(db: &support::TestDatabase, series_id: Uuid) -> season::Model {
    season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series_id),
        number: Set(1),
    }
    .insert(&**db)
    .await
    .unwrap()
}

// Catches either MCP creation path mutating an archived parent before checking its locked state.
#[tokio::test]
async fn mcp_rejects_archived_series_child_creation_without_versions_or_children_changing() {
    let (db, app, root) = setup().await;
    let archived = insert_series(&db, "archived", 7).await;
    let existing_season = insert_season(&db, archived.id).await;

    let season_response = send(
        &app,
        &format!("/api/admin/series/{}/seasons", archived.id),
        json!({"version":7,"number":2}),
    )
    .await;
    assert_eq!(season_response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(season_response).await,
        json!({"error":"series state, hierarchy, or version conflict"})
    );

    let episode_response = send(
        &app,
        &format!(
            "/api/admin/series/{}/seasons/{}/episodes",
            archived.id, existing_season.id
        ),
        json!({"version":7,"number":1,"name":"Blocked","duration_seconds":60}),
    )
    .await;
    assert_eq!(episode_response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(episode_response).await,
        json!({"error":"series state, hierarchy, or version conflict"})
    );

    assert_eq!(season::Entity::find().count(&*db).await.unwrap(), 1);
    assert_eq!(episode::Entity::find().count(&*db).await.unwrap(), 0);
    let unchanged = series::Entity::find_by_id(archived.id)
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.status, "archived");
    assert_eq!(unchanged.version, 7);
    let _ = std::fs::remove_dir_all(root);
}

// Catches accidentally applying the archived MCP gate to the supported published-series workflow.
#[tokio::test]
async fn mcp_keeps_published_series_open_for_new_draft_seasons_and_episodes() {
    let (db, app, root) = setup().await;
    let published = insert_series(&db, "published", 4).await;
    let existing_season = insert_season(&db, published.id).await;

    let season_response = send(
        &app,
        &format!("/api/admin/series/{}/seasons", published.id),
        json!({"version":4,"number":2}),
    )
    .await;
    assert_eq!(season_response.status(), StatusCode::CREATED);
    let with_season = body(season_response).await;
    assert_eq!(with_season["status"], "published");
    assert_eq!(with_season["version"], 5);
    assert_eq!(with_season["seasons"].as_array().unwrap().len(), 2);

    let episode_response = send(
        &app,
        &format!(
            "/api/admin/series/{}/seasons/{}/episodes",
            published.id, existing_season.id
        ),
        json!({"version":5,"number":1,"name":"New draft","duration_seconds":60}),
    )
    .await;
    assert_eq!(episode_response.status(), StatusCode::CREATED);
    let with_episode = body(episode_response).await;
    assert_eq!(with_episode["status"], "published");
    assert_eq!(with_episode["version"], 6);
    assert_eq!(with_episode["seasons"][0]["episodes"][0]["status"], "draft");
    assert_eq!(with_episode["seasons"][0]["episodes"][0]["version"], 1);
    let _ = std::fs::remove_dir_all(root);
}
