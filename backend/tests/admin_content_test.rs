mod support;

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    admin_content::{
        dto::AdminContentFilter,
        query::{self, ADMIN_CONTENT_ITEMS_SQL},
    },
    app,
    config::Config,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use support::TestDatabase;
use tower::ServiceExt;
use uuid::Uuid;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("movie_harbor_admin_content_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl AsRef<Path> for TempRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

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
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn request(app: &Router, uri: &str, cookie: Option<&str>) -> Response {
    let mut builder = Request::builder().uri(uri).header("host", "harbor.test");
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let mut request = builder.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn credentials(app: &Router) -> String {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"name":"Admin","password":"initial-password"}).to_string(),
        ))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn list(app: &Router, cookie: &str, query: &str) -> Value {
    let response = request(app, &format!("/api/admin/contents{query}"), Some(cookie)).await;
    assert_eq!(response.status(), StatusCode::OK, "{query}");
    body(response).await
}

async fn wait_for_locked_items_query(db: &DatabaseConnection) {
    let marker = ADMIN_CONTENT_ITEMS_SQL
        .trim()
        .lines()
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    for _ in 0..300 {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
SELECT EXISTS (
    SELECT 1
    FROM pg_stat_activity activity
    JOIN pg_locks lock ON lock.pid = activity.pid
    WHERE activity.wait_event_type = 'Lock'
      AND activity.query LIKE '%' || $1::text || '%'
      AND lock.locktype = 'relation'
      AND NOT lock.granted
      AND lock.relation = to_regclass('media_asset')::oid
) AS blocked
"#,
                vec![marker.clone().into()],
            ))
            .await
            .unwrap()
            .unwrap();
        if row.try_get::<bool>("", "blocked").unwrap() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("admin content items query did not block on media_asset as expected");
}

async fn seeded_app() -> (TestDatabase, TempRoot, Router) {
    let db = TestDatabase::migrated("admin_content").await;
    db.execute_unprepared(
        r#"
INSERT INTO movie (id, name, status, version, created_at) VALUES
('10000000-0000-0000-0000-000000000001', 'Movie 01', 'draft', 1, '2026-01-22T00:00:00Z'),
('10000000-0000-0000-0000-000000000002', 'Movie 02', 'draft', 2, '2026-01-21T00:00:00Z'),
('10000000-0000-0000-0000-000000000003', 'Movie 03', 'draft', 3, '2026-01-20T00:00:00Z'),
('10000000-0000-0000-0000-000000000004', 'Movie 04', 'draft', 4, '2026-01-18T00:00:00Z'),
('10000000-0000-0000-0000-000000000005', 'Movie 05', 'draft', 5, '2026-01-16T00:00:00Z'),
('10000000-0000-0000-0000-000000000006', 'Movie 06', 'draft', 6, '2026-01-14T00:00:00Z'),
('10000000-0000-0000-0000-000000000007', 'Movie 07', 'published', 7, '2026-01-12T00:00:00Z'),
('10000000-0000-0000-0000-000000000008', 'Movie 08', 'published', 8, '2026-01-10T00:00:00Z'),
('10000000-0000-0000-0000-000000000009', 'Movie 09', 'published', 9, '2026-01-08T00:00:00Z'),
('10000000-0000-0000-0000-000000000010', 'Movie 10', 'archived', 10, '2026-01-06T00:00:00Z'),
('10000000-0000-0000-0000-000000000011', 'Movie 11', 'archived', 11, '2026-01-04T00:00:00Z'),
('10000000-0000-0000-0000-000000000012', 'Movie 12', 'archived', 12, '2026-01-02T00:00:00Z');

INSERT INTO series (id, name, status, version, created_at) VALUES
('20000000-0000-0000-0000-000000000001', '100%_! Series', 'draft', 21, '2026-01-21T00:00:00Z'),
('20000000-0000-0000-0000-000000000002', 'Series 02', 'published', 22, '2026-01-19T00:00:00Z'),
('20000000-0000-0000-0000-000000000003', 'Series 03', 'archived', 23, '2026-01-17T00:00:00Z'),
('20000000-0000-0000-0000-000000000004', 'Series 04', 'draft', 24, '2026-01-15T00:00:00Z'),
('20000000-0000-0000-0000-000000000005', 'Series 05', 'published', 25, '2026-01-13T00:00:00Z'),
('20000000-0000-0000-0000-000000000006', 'Series 06', 'archived', 26, '2026-01-11T00:00:00Z'),
('20000000-0000-0000-0000-000000000007', 'Series 07', 'draft', 27, '2026-01-09T00:00:00Z'),
('20000000-0000-0000-0000-000000000008', 'Series 08', 'published', 28, '2026-01-07T00:00:00Z'),
('20000000-0000-0000-0000-000000000009', 'Series 09', 'archived', 29, '2026-01-05T00:00:00Z'),
('20000000-0000-0000-0000-000000000010', 'Series 10', 'draft', 30, '2026-01-03T00:00:00Z');
"#,
    )
    .await
    .unwrap();
    let root = TempRoot::new();
    let app = app::build(db.connection(), &config(root.as_ref()))
        .await
        .unwrap();
    (db, root, app)
}

fn tuples(payload: &Value) -> Vec<(String, String, String)> {
    payload["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["created_at"].as_str().unwrap().to_owned(),
                item["kind"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn admin_content_is_authenticated_paginated_and_stably_sorted() {
    let (_db, _root, app) = seeded_app().await;
    let cookie = credentials(&app).await;

    assert_eq!(
        request(&app, "/api/admin/contents", None).await.status(),
        StatusCode::UNAUTHORIZED
    );

    let response = request(&app, "/api/admin/contents?page=2", Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = body(response).await;
    assert_eq!(payload["page"], 2);
    assert_eq!(payload["size"], 20);
    assert_eq!(payload["total"], 22);
    assert_eq!(payload["items"].as_array().unwrap().len(), 2);
    assert!(payload["items"][0].get("seasons").is_none());
    assert!(payload["items"][0].get("genres").is_none());

    let first = list(&app, &cookie, "?page=1").await;
    let mut actual = tuples(&first);
    actual.extend(tuples(&payload));
    let expected = vec![
        (
            "2026-01-22T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000001",
        ),
        (
            "2026-01-21T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000002",
        ),
        (
            "2026-01-21T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000001",
        ),
        (
            "2026-01-20T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000003",
        ),
        (
            "2026-01-19T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000002",
        ),
        (
            "2026-01-18T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000004",
        ),
        (
            "2026-01-17T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000003",
        ),
        (
            "2026-01-16T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000005",
        ),
        (
            "2026-01-15T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000004",
        ),
        (
            "2026-01-14T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000006",
        ),
        (
            "2026-01-13T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000005",
        ),
        (
            "2026-01-12T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000007",
        ),
        (
            "2026-01-11T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000006",
        ),
        (
            "2026-01-10T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000008",
        ),
        (
            "2026-01-09T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000007",
        ),
        (
            "2026-01-08T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000009",
        ),
        (
            "2026-01-07T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000008",
        ),
        (
            "2026-01-06T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000010",
        ),
        (
            "2026-01-05T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000009",
        ),
        (
            "2026-01-04T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000011",
        ),
        (
            "2026-01-03T00:00:00+00:00",
            "series",
            "20000000-0000-0000-0000-000000000010",
        ),
        (
            "2026-01-02T00:00:00+00:00",
            "movie",
            "10000000-0000-0000-0000-000000000012",
        ),
    ]
    .into_iter()
    .map(|(created_at, kind, id)| (created_at.into(), kind.into(), id.into()))
    .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn admin_content_filters_and_literal_name_search_are_applied() {
    let (_db, _root, app) = seeded_app().await;
    let cookie = credentials(&app).await;

    assert_eq!(
        list(&app, &cookie, "?kind=movie&status=draft").await["items"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    let series = list(&app, &cookie, "?kind=series&name=%25_%21").await;
    assert_eq!(series["items"][0]["name"], "100%_! Series");
    assert_eq!(series["total"], 1);

    let beyond_end = list(&app, &cookie, "?page=999").await;
    assert_eq!(beyond_end["items"].as_array().unwrap().len(), 0);
    assert_eq!(beyond_end["total"], 22);
}

#[tokio::test]
async fn admin_content_rejects_invalid_filters_and_page_boundaries() {
    let (_db, _root, app) = seeded_app().await;
    let cookie = credentials(&app).await;

    for query in ["?kind=video", "?status=deleted", "?page=0", "?page=1000001"] {
        let response = request(&app, &format!("/api/admin/contents{query}"), Some(&cookie)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(
            body(response).await,
            json!({"error":"invalid content list request"})
        );
    }
}

#[tokio::test]
async fn admin_content_only_exposes_controlled_poster_urls() {
    let db = TestDatabase::migrated("admin_content_posters").await;
    db.execute_unprepared(
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('30000000-0000-0000-0000-000000000001', 'poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'valid.png', 'image/png', 1, 'poster'),
('30000000-0000-0000-0000-000000000002', 'poster/bb/../broken.png', 'broken.png', 'image/png', 1, 'poster');
INSERT INTO movie (id, name, poster_asset_id, status, created_at) VALUES
('30000000-0000-0000-0000-000000000003', 'Valid poster', '30000000-0000-0000-0000-000000000001', 'draft', '2026-02-02T00:00:00Z'),
('30000000-0000-0000-0000-000000000004', 'Broken poster', '30000000-0000-0000-0000-000000000002', 'draft', '2026-02-01T00:00:00Z');
"#,
    )
    .await
    .unwrap();
    let root = TempRoot::new();
    let app = app::build(db.connection(), &config(root.as_ref()))
        .await
        .unwrap();
    let cookie = credentials(&app).await;
    let payload = list(&app, &cookie, "?kind=movie").await;

    assert_eq!(payload["items"][0]["name"], "Valid poster");
    assert_eq!(
        payload["items"][0]["poster_url"],
        "/media/poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"
    );
    assert_eq!(payload["items"][1]["name"], "Broken poster");
    assert!(payload["items"][1]["poster_url"].is_null());
}

#[tokio::test]
async fn admin_content_total_and_items_share_one_snapshot() {
    let db = TestDatabase::migrated("admin_content_snapshot").await;
    db.execute_unprepared(
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('40000000-0000-0000-0000-000000000001', 'poster/44/44444444444444444444444444444444.png', 'old.png', 'image/png', 1, 'poster');
INSERT INTO movie (id, name, poster_asset_id, status, created_at) VALUES
('40000000-0000-0000-0000-000000000002', 'Old movie', '40000000-0000-0000-0000-000000000001', 'draft', '2026-01-01T00:00:00Z');
"#,
    )
    .await
    .unwrap();

    let blocker = db.begin().await.unwrap();
    blocker
        .execute_unprepared("LOCK TABLE media_asset IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let read_db = db.connection();
    let list_task = tokio::spawn(async move {
        query::list(
            &read_db,
            AdminContentFilter {
                kind: "movie".into(),
                status: None,
                name_pattern: None,
                page: 1,
                offset: 0,
            },
        )
        .await
        .unwrap()
    });

    wait_for_locked_items_query(&db).await;
    blocker
        .execute_unprepared(
            r#"
DELETE FROM movie WHERE id = '40000000-0000-0000-0000-000000000002';
INSERT INTO movie (id, name, status, created_at) VALUES
('40000000-0000-0000-0000-000000000003', 'New movie one', 'draft', '2026-02-01T00:00:00Z'),
('40000000-0000-0000-0000-000000000004', 'New movie two', 'draft', '2026-02-02T00:00:00Z');
"#,
        )
        .await
        .unwrap();
    blocker.commit().await.unwrap();

    let page = tokio::time::timeout(std::time::Duration::from_secs(3), list_task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].name, "Old movie");
}
