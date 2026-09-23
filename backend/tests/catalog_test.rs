use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    app,
    catalog::{
        dto::{CatalogFilter, CatalogKind},
        query::{self, CATALOG_ITEMS_SQL, CATALOG_SEARCH_ITEMS_SQL},
    },
    config::Config,
};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tower::ServiceExt;
use uuid::Uuid;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_catalog_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
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

async fn database(label: &str) -> DatabaseConnection {
    database_with_migrations(label, None).await
}

async fn database_with_migrations(label: &str, steps: Option<u32>) -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("catalog_{label}_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut options = ConnectOptions::new(url);
    options.set_schema_search_path(schema);
    let db = Database::connect(options).await.unwrap();
    migration::Migrator::up(&db, steps).await.unwrap();
    db
}

async fn wait_for_locked_query(db: &DatabaseConnection, relation: &str, fragment: &str) {
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
      AND lock.relation = to_regclass($2::text)::oid
) AS blocked
"#,
                vec![fragment.into(), relation.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        if row.try_get::<bool>("", "blocked").unwrap() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("catalog query containing {fragment:?} did not block on {relation:?} as expected");
}

async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

async fn get(app: &Router, uri: &str) -> Response {
    app.clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn encoded(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn built_app(db: DatabaseConnection, root: &TempRoot) -> Router {
    app::build(db, &config(root.as_ref())).await.unwrap()
}

fn assert_public_payload(payload: &Value) {
    let text = payload.to_string();
    for private_field in [
        "storage_key",
        "original_name",
        "mime_type",
        "byte_size",
        "local_path",
        "status",
        "version",
        "archived_at",
        "created_at",
        "updated_at",
        "poster_asset_id",
        "video_asset_id",
    ] {
        assert!(
            !text.contains(private_field),
            "public payload leaked {private_field}: {text}"
        );
    }
}

#[tokio::test]
async fn catalog_is_public_filtered_paginated_and_deterministically_sorted() {
    let db = database("listing").await;
    sql(
        &db,
        r#"
INSERT INTO movie (id, name, status, published_at) VALUES
('10000000-0000-0000-0000-000000000001', 'Older movie', 'published', '2026-01-01T00:00:00Z'),
('10000000-0000-0000-0000-000000000002', 'Tie movie B', 'published', '2026-03-01T00:00:00Z'),
('10000000-0000-0000-0000-000000000001', 'impossible duplicate', 'draft', NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO movie (id, name, status, published_at) VALUES
('10000000-0000-0000-0000-000000000003', 'Hidden draft movie', 'draft', NULL),
('10000000-0000-0000-0000-000000000004', 'Hidden archived movie', 'archived', '2026-04-01T00:00:00Z');
INSERT INTO series (id, name, status, published_at) VALUES
('20000000-0000-0000-0000-000000000001', 'Tie series', 'published', '2026-03-01T00:00:00Z'),
('20000000-0000-0000-0000-000000000002', 'Newest series', 'published', '2026-04-01T00:00:00Z'),
('20000000-0000-0000-0000-000000000003', 'Hidden archived series', 'archived', '2026-05-01T00:00:00Z');
"#,
    )
    .await;
    let root = TempRoot::new();
    let app = built_app(db, &root).await;

    let response = get(&app, "/api/catalog?kind=all&page=1&size=2").await;
    assert_eq!(response.status(), StatusCode::OK);
    let first = json_body(response).await;
    assert_eq!(first["page"], 1);
    assert_eq!(first["size"], 2);
    assert_eq!(first["total"], 4);
    assert_eq!(first["items"][0]["name"], "Newest series");
    assert_eq!(first["items"][1]["name"], "Tie movie B");
    assert_public_payload(&first);

    let second = json_body(get(&app, "/api/catalog?kind=all&page=2&size=2").await).await;
    assert_eq!(second["items"][0]["name"], "Tie series");
    assert_eq!(second["items"][1]["name"], "Older movie");

    let movies = json_body(get(&app, "/api/catalog?kind=movie").await).await;
    assert_eq!(movies["total"], 2);
    assert!(
        movies["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["kind"] == "movie")
    );
    let series = json_body(get(&app, "/api/catalog?kind=series").await).await;
    assert_eq!(series["total"], 2);
    assert!(
        series["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["kind"] == "series")
    );
}

#[tokio::test]
async fn catalog_validates_kind_page_and_bounded_size() {
    let db = database("validation").await;
    let root = TempRoot::new();
    let app = built_app(db, &root).await;

    for uri in [
        "/api/catalog?kind=episode",
        "/api/catalog?page=0",
        "/api/catalog?page=-1",
        "/api/catalog?size=0",
        "/api/catalog?size=101",
        "/api/catalog?page=18446744073709551615&size=100",
    ] {
        assert_eq!(
            get(&app, uri).await.status(),
            StatusCode::BAD_REQUEST,
            "{uri}"
        );
    }

    let max = get(&app, "/api/catalog?page=1&size=100").await;
    assert_eq!(max.status(), StatusCode::OK);
    let defaults = json_body(get(&app, "/api/catalog").await).await;
    assert_eq!(defaults["page"], 1);
    assert_eq!(defaults["size"], 20);
}

#[tokio::test]
async fn search_matches_name_or_synopsis_case_insensitively_and_treats_metacharacters_literally() {
    let db = database("search").await;
    sql(
        &db,
        r#"
INSERT INTO movie (id, name, synopsis, status, published_at) VALUES
('30000000-0000-0000-0000-000000000001', '100%_Real\CAFÉ', 'CAFÉ appears in both fields', 'published', '2026-01-03T00:00:00Z'),
('30000000-0000-0000-0000-000000000002', '100xxReal cafe', 'ordinary', 'published', '2026-01-02T00:00:00Z'),
('30000000-0000-0000-0000-000000000003', '中文标题', '一次星际旅程', 'published', '2026-01-01T00:00:00Z'),
('30000000-0000-0000-0000-000000000004', 'Archived CAFÉ', '星际', 'archived', '2026-01-04T00:00:00Z');
INSERT INTO series (id, name, synopsis, status, published_at) VALUES
('31000000-0000-0000-0000-000000000001', 'Public series', '海港谜案', 'published', '2026-01-04T00:00:00Z'),
('31000000-0000-0000-0000-000000000002', 'Hidden series', '海港谜案', 'draft', NULL);
"#,
    )
    .await;
    let root = TempRoot::new();
    let app = built_app(db, &root).await;

    for (query, expected) in [
        ("%", vec!["100%_Real\\CAFÉ"]),
        ("_", vec!["100%_Real\\CAFÉ"]),
        ("\\", vec!["100%_Real\\CAFÉ"]),
        ("café", vec!["100%_Real\\CAFÉ"]),
        ("星际", vec!["中文标题"]),
        ("海港", vec!["Public series"]),
    ] {
        let payload =
            json_body(get(&app, &format!("/api/catalog?q={}", encoded(query))).await).await;
        let names = payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, expected, "query {query:?}");
    }

    let blank = json_body(get(&app, "/api/catalog?q=%20%20%20").await).await;
    assert_eq!(blank["total"], 4);

    let series_only = json_body(
        get(
            &app,
            &format!("/api/catalog?kind=series&q={}", encoded("海港")),
        )
        .await,
    )
    .await;
    assert_eq!(series_only["total"], 1);
    assert_eq!(series_only["items"][0]["kind"], "series");
}

#[tokio::test]
async fn cards_include_safe_poster_and_first_three_ordered_genres_with_total_count() {
    let db = database("cards").await;
    sql(
        &db,
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('41000000-0000-0000-0000-000000000001', 'poster/41/41000000000000000000000000000001.png', 'private.png', 'image/png', 99, 'poster'),
('41000000-0000-0000-0000-000000000002', '../private/secret.png', 'secret.png', 'image/png', 99, 'poster');
INSERT INTO movie (id, name, poster_asset_id, status, published_at) VALUES
('42000000-0000-0000-0000-000000000001', 'Safe card', '41000000-0000-0000-0000-000000000001', 'published', '2026-02-02T00:00:00Z'),
('42000000-0000-0000-0000-000000000002', 'Corrupt key card', '41000000-0000-0000-0000-000000000002', 'published', '2026-02-01T00:00:00Z');
INSERT INTO genre (id, name, sort_order, enabled) VALUES
('43000000-0000-0000-0000-000000000004', 'Fourth', 40, true),
('43000000-0000-0000-0000-000000000002', 'Second', 20, false),
('43000000-0000-0000-0000-000000000003', 'Third', 30, true),
('43000000-0000-0000-0000-000000000001', 'First', 10, true);
INSERT INTO movie_genre (movie_id, genre_id) SELECT '42000000-0000-0000-0000-000000000001', id FROM genre WHERE name IN ('First', 'Second', 'Third', 'Fourth');
"#,
    )
    .await;
    let root = TempRoot::new();
    let app = built_app(db, &root).await;
    let payload = json_body(get(&app, "/api/catalog?kind=movie").await).await;

    assert_eq!(
        payload["items"][0]["poster_url"],
        "/media/poster/41/41000000000000000000000000000001.png"
    );
    assert_eq!(payload["items"][0]["genre_count"], 4);
    assert_eq!(payload["items"][0]["genres"][0]["name"], "First");
    assert_eq!(payload["items"][0]["genres"][1]["name"], "Second");
    assert_eq!(payload["items"][0]["genres"][2]["name"], "Third");
    assert_eq!(payload["items"][0]["genres"].as_array().unwrap().len(), 3);
    assert!(payload["items"][1]["poster_url"].is_null());
    assert_public_payload(&payload);
}

#[tokio::test]
async fn movie_detail_returns_only_public_fields_and_hidden_movies_are_not_found() {
    let db = database("movie_detail").await;
    sql(
        &db,
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('51000000-0000-0000-0000-000000000001', 'poster/51/51000000000000000000000000000001.webp', 'poster-private.webp', 'image/webp', 11, 'poster'),
('51000000-0000-0000-0000-000000000002', 'video/51/51000000000000000000000000000002.mp4', 'video-private.mp4', 'video/mp4', 22, 'video');
INSERT INTO movie (id, name, synopsis, year, duration_seconds, poster_asset_id, video_asset_id, status, version, published_at) VALUES
('52000000-0000-0000-0000-000000000001', 'Public movie', 'Visible synopsis', 2026, 7200, '51000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 'published', 9, '2026-01-01T00:00:00Z'),
('52000000-0000-0000-0000-000000000002', 'Draft movie', 'Private', 2026, 1, NULL, NULL, 'draft', 2, NULL),
('52000000-0000-0000-0000-000000000003', 'Archived movie', 'Private', 2026, 1, NULL, NULL, 'archived', 3, '2026-01-01T00:00:00Z'),
('52000000-0000-0000-0000-000000000004', 'Published without media', 'Visible', 2026, NULL, NULL, NULL, 'published', 1, '2025-01-01T00:00:00Z');
INSERT INTO genre (id, name, sort_order) VALUES
('53000000-0000-0000-0000-000000000002', 'Later', 2),
('53000000-0000-0000-0000-000000000001', 'Earlier', 1);
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('52000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000002'),
('52000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001');
"#,
    )
    .await;
    let root = TempRoot::new();
    let app = built_app(db, &root).await;

    let response = get(
        &app,
        "/api/catalog/movies/52000000-0000-0000-0000-000000000001",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let detail = json_body(response).await;
    assert_eq!(detail["name"], "Public movie");
    assert_eq!(detail["duration_seconds"], 7200);
    assert_eq!(
        detail["poster_url"],
        "/media/poster/51/51000000000000000000000000000001.webp"
    );
    assert_eq!(
        detail["video_url"],
        "/media/video/51/51000000000000000000000000000002.mp4"
    );
    assert_eq!(detail["genres"][0]["name"], "Earlier");
    assert_eq!(detail["genres"][1]["name"], "Later");
    assert_public_payload(&detail);

    for id in [
        "52000000-0000-0000-0000-000000000002",
        "52000000-0000-0000-0000-000000000003",
        "52000000-0000-0000-0000-000000000099",
    ] {
        assert_eq!(
            get(&app, &format!("/api/catalog/movies/{id}"))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    let missing_media = json_body(
        get(
            &app,
            "/api/catalog/movies/52000000-0000-0000-0000-000000000004",
        )
        .await,
    )
    .await;
    assert!(missing_media["poster_url"].is_null());
    assert!(missing_media["video_url"].is_null());
}

#[tokio::test]
async fn series_detail_groups_only_published_episodes_and_parent_visibility_is_effective() {
    let db = database("series_detail").await;
    sql(
        &db,
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('61000000-0000-0000-0000-000000000001', 'poster/61/61000000000000000000000000000001.png', 'poster.png', 'image/png', 10, 'poster'),
('61000000-0000-0000-0000-000000000002', 'video/61/61000000000000000000000000000002.webm', 'episode.webm', 'video/webm', 20, 'video');
INSERT INTO series (id, name, synopsis, year, poster_asset_id, status, version, published_at) VALUES
('62000000-0000-0000-0000-000000000001', 'Public series', 'Visible synopsis', 2025, '61000000-0000-0000-0000-000000000001', 'published', 7, '2026-01-01T00:00:00Z'),
('62000000-0000-0000-0000-000000000002', 'Draft series', 'Private', 2025, NULL, 'draft', 1, NULL),
('62000000-0000-0000-0000-000000000003', 'Archived series', 'Private', 2025, NULL, 'archived', 1, '2025-01-01T00:00:00Z');
INSERT INTO season (id, series_id, number) VALUES
('63000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001', 2),
('63000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 1),
('63000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001', 3);
INSERT INTO episode (id, season_id, number, name, duration_seconds, video_asset_id, status, published_at) VALUES
('64000000-0000-0000-0000-000000000002', '63000000-0000-0000-0000-000000000001', 2, 'Second', 120, NULL, 'published', '2026-01-02T00:00:00Z'),
('64000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000001', 1, 'Dulcinea', 2700, '61000000-0000-0000-0000-000000000002', 'published', '2026-01-01T00:00:00Z'),
('64000000-0000-0000-0000-000000000003', '63000000-0000-0000-0000-000000000002', 1, 'Draft episode', 100, NULL, 'draft', NULL),
('64000000-0000-0000-0000-000000000004', '63000000-0000-0000-0000-000000000002', 2, 'Archived episode', 100, NULL, 'archived', '2025-01-01T00:00:00Z');
"#,
    )
    .await;
    let root = TempRoot::new();
    let app = built_app(db.clone(), &root).await;
    let path = "/api/catalog/series/62000000-0000-0000-0000-000000000001";

    let response = get(&app, path).await;
    assert_eq!(response.status(), StatusCode::OK);
    let detail = json_body(response).await;
    assert_eq!(detail["seasons"].as_array().unwrap().len(), 1);
    assert_eq!(detail["seasons"][0]["number"], 1);
    assert_eq!(
        detail["seasons"][0]["episodes"].as_array().unwrap().len(),
        2
    );
    let episode = &detail["seasons"][0]["episodes"][0];
    assert!(episode.get("synopsis").is_none());
    assert_eq!(episode["name"], "Dulcinea");
    assert_eq!(episode["duration_seconds"], 2700);
    assert_eq!(
        detail["seasons"][0]["episodes"][0]["video_url"],
        "/media/video/61/61000000000000000000000000000002.webm"
    );
    assert_eq!(detail["seasons"][0]["episodes"][1]["name"], "Second");
    assert!(detail["seasons"][0]["episodes"][1]["video_url"].is_null());
    assert_public_payload(&detail);

    for id in [
        "62000000-0000-0000-0000-000000000002",
        "62000000-0000-0000-0000-000000000003",
        "62000000-0000-0000-0000-000000000099",
    ] {
        assert_eq!(
            get(&app, &format!("/api/catalog/series/{id}"))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    sql(
        &db,
        "UPDATE series SET status = 'archived' WHERE id = '62000000-0000-0000-0000-000000000001'",
    )
    .await;
    assert_eq!(get(&app, path).await.status(), StatusCode::NOT_FOUND);
    let row = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT status FROM episode WHERE id = '64000000-0000-0000-0000-000000000001'",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "status").unwrap(), "published");
    sql(
        &db,
        "UPDATE series SET status = 'published' WHERE id = '62000000-0000-0000-0000-000000000001'",
    )
    .await;
    assert_eq!(get(&app, path).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn series_detail_never_combines_parent_and_episode_visibility_from_different_snapshots() {
    let db = database("series_snapshot").await;
    sql(
        &db,
        r#"
INSERT INTO series (id, name, status, published_at) VALUES
('65000000-0000-0000-0000-000000000001', 'Snapshot series', 'published', '2026-01-01T00:00:00Z');
INSERT INTO season (id, series_id, number) VALUES
('65000000-0000-0000-0000-000000000002', '65000000-0000-0000-0000-000000000001', 1);
INSERT INTO episode (id, season_id, number, name, status, published_at) VALUES
('65000000-0000-0000-0000-000000000003', '65000000-0000-0000-0000-000000000002', 1, 'Previously public', 'published', '2026-01-01T00:00:00Z'),
('65000000-0000-0000-0000-000000000004', '65000000-0000-0000-0000-000000000002', 2, 'Never effectively public', 'draft', NULL);
"#,
    )
    .await;

    let blocker = db.begin().await.unwrap();
    blocker
        .execute_unprepared("LOCK TABLE series_genre IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let read_db = db.clone();
    let detail_task = tokio::spawn(async move {
        query::series_detail(
            &read_db,
            Uuid::parse_str("65000000-0000-0000-0000-000000000001").unwrap(),
        )
        .await
        .unwrap()
        .unwrap()
    });

    wait_for_locked_query(&db, "series_genre", "WITH requested(kind, id)").await;
    blocker
        .execute_unprepared(
            r#"
UPDATE series
SET status = 'archived', archived_at = CURRENT_TIMESTAMP
WHERE id = '65000000-0000-0000-0000-000000000001';
UPDATE episode
SET status = 'published', published_at = CURRENT_TIMESTAMP
WHERE id = '65000000-0000-0000-0000-000000000004';
"#,
        )
        .await
        .unwrap();
    blocker.commit().await.unwrap();

    let detail = tokio::time::timeout(std::time::Duration::from_secs(3), detail_task)
        .await
        .unwrap()
        .unwrap();
    let episode_names = detail
        .seasons
        .iter()
        .flat_map(|season| season.episodes.iter())
        .map(|episode| episode.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(episode_names, ["Previously public"]);
}

#[tokio::test]
async fn movie_detail_never_combines_parent_and_genres_from_different_snapshots() {
    let db = database("movie_snapshot").await;
    sql(
        &db,
        r#"
INSERT INTO movie (id, name, status, published_at) VALUES
('65500000-0000-0000-0000-000000000001', 'Snapshot movie', 'published', '2026-01-01T00:00:00Z');
INSERT INTO genre (id, name, sort_order) VALUES
('65500000-0000-0000-0000-000000000002', 'Old genre', 1),
('65500000-0000-0000-0000-000000000003', 'New genre', 2);
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('65500000-0000-0000-0000-000000000001', '65500000-0000-0000-0000-000000000002');
"#,
    )
    .await;

    let blocker = db.begin().await.unwrap();
    blocker
        .execute_unprepared("LOCK TABLE movie_genre IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let read_db = db.clone();
    let detail_task = tokio::spawn(async move {
        query::movie_detail(
            &read_db,
            Uuid::parse_str("65500000-0000-0000-0000-000000000001").unwrap(),
        )
        .await
        .unwrap()
        .unwrap()
    });

    wait_for_locked_query(&db, "movie_genre", "WITH requested(kind, id)").await;
    blocker
        .execute_unprepared(
            r#"
UPDATE movie
SET status = 'archived', archived_at = CURRENT_TIMESTAMP
WHERE id = '65500000-0000-0000-0000-000000000001';
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('65500000-0000-0000-0000-000000000001', '65500000-0000-0000-0000-000000000003');
"#,
        )
        .await
        .unwrap();
    blocker.commit().await.unwrap();

    let detail = tokio::time::timeout(std::time::Duration::from_secs(3), detail_task)
        .await
        .unwrap()
        .unwrap();
    let genres = detail
        .genres
        .iter()
        .map(|genre| genre.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(genres, ["Old genre"]);
}

#[tokio::test]
async fn catalog_total_and_items_share_a_snapshot_during_publication_changes() {
    let db = database("list_snapshot").await;
    sql(
        &db,
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('66000000-0000-0000-0000-000000000001', 'poster/66/66000000000000000000000000000001.png', 'poster.png', 'image/png', 1, 'poster');
INSERT INTO movie (id, name, poster_asset_id, status, published_at) VALUES
('66000000-0000-0000-0000-000000000002', 'Old public movie', '66000000-0000-0000-0000-000000000001', 'published', '2026-01-01T00:00:00Z'),
('66000000-0000-0000-0000-000000000003', 'New movie one', NULL, 'draft', NULL),
('66000000-0000-0000-0000-000000000004', 'New movie two', NULL, 'draft', NULL);
"#,
    )
    .await;

    let blocker = db.begin().await.unwrap();
    blocker
        .execute_unprepared("LOCK TABLE media_asset IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let read_db = db.clone();
    let list_task = tokio::spawn(async move {
        query::list(
            &read_db,
            CatalogFilter {
                kind: CatalogKind::Movie,
                search_pattern: None,
                page: 1,
                size: 20,
                offset: 0,
                window: 20,
            },
        )
        .await
        .unwrap()
    });

    wait_for_locked_query(&db, "media_asset", "WITH candidates AS").await;
    blocker
        .execute_unprepared(
            r#"
UPDATE movie SET status = 'archived', archived_at = CURRENT_TIMESTAMP
WHERE id = '66000000-0000-0000-0000-000000000002';
UPDATE movie SET status = 'published', published_at = CURRENT_TIMESTAMP
WHERE id IN (
    '66000000-0000-0000-0000-000000000003',
    '66000000-0000-0000-0000-000000000004'
);
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
    assert_eq!(page.items[0].name, "Old public movie");
}

#[tokio::test]
async fn publication_indexes_accept_long_noncompressible_names_on_publish() {
    let db = database("long_publish").await;
    sql(
        &db,
        r#"
WITH long_name AS (
    SELECT string_agg(md5(value::text), '' ORDER BY value) AS name
    FROM generate_series(1, 200) value
)
INSERT INTO movie (id, name, status)
SELECT '67000000-0000-0000-0000-000000000001', name, 'draft' FROM long_name;
WITH long_name AS (
    SELECT string_agg(md5((value + 1000)::text), '' ORDER BY value) AS name
    FROM generate_series(1, 200) value
)
INSERT INTO series (id, name, status)
SELECT '67000000-0000-0000-0000-000000000002', name, 'draft' FROM long_name;
UPDATE movie SET status = 'published', published_at = CURRENT_TIMESTAMP
WHERE id = '67000000-0000-0000-0000-000000000001';
UPDATE series SET status = 'published', published_at = CURRENT_TIMESTAMP
WHERE id = '67000000-0000-0000-0000-000000000002';
"#,
    )
    .await;
}

#[tokio::test]
async fn publication_index_migration_accepts_preexisting_long_published_names_and_reapplies() {
    let db = database_with_migrations("long_migration", Some(2)).await;
    sql(
        &db,
        r#"
WITH long_name AS (
    SELECT string_agg(md5(value::text), '' ORDER BY value) AS name
    FROM generate_series(1, 200) value
)
INSERT INTO movie (id, name, status, published_at)
SELECT '68000000-0000-0000-0000-000000000001', name, 'published', CURRENT_TIMESTAMP FROM long_name;
WITH long_name AS (
    SELECT string_agg(md5((value + 1000)::text), '' ORDER BY value) AS name
    FROM generate_series(1, 200) value
)
INSERT INTO series (id, name, status, published_at)
SELECT '68000000-0000-0000-0000-000000000002', name, 'published', CURRENT_TIMESTAMP FROM long_name;
"#,
    )
    .await;

    migration::Migrator::up(&db, None).await.unwrap();
    migration::Migrator::down(&db, Some(3)).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
}

#[tokio::test]
async fn public_catalog_indexes_are_reversible_and_support_bounded_plans() {
    let db = database("indexes").await;
    let expected_indexes = [
        "movie_public_published_idx",
        "series_public_published_idx",
        "movie_name_search_idx",
        "movie_synopsis_search_idx",
        "series_name_search_idx",
        "series_synopsis_search_idx",
        "episode_public_season_idx",
        "movie_poster_asset_idx",
        "movie_video_asset_idx",
        "series_poster_asset_idx",
        "episode_video_asset_idx",
        "movie_genre_genre_idx",
        "series_genre_genre_idx",
    ];
    let index_names = expected_indexes
        .iter()
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            format!(
                "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ({index_names})"
            ),
        ))
        .await
        .unwrap();
    let mut actual = rows
        .into_iter()
        .map(|row| row.try_get::<String>("", "indexname").unwrap())
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = expected_indexes.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(actual, expected);

    sql(
        &db,
        r#"
INSERT INTO movie (id, name, synopsis, status, published_at)
SELECT gen_random_uuid(), 'Movie ' || value,
       CASE WHEN value = 7771 THEN 'needle-catalog-token' ELSE 'ordinary synopsis' END,
       CASE WHEN value % 10 <> 0 THEN 'published' ELSE 'draft' END,
       CASE WHEN value % 10 <> 0 THEN CURRENT_TIMESTAMP - value * INTERVAL '1 second' END
FROM generate_series(1, 20000) value;
INSERT INTO series (id, name, synopsis, status, published_at)
SELECT gen_random_uuid(),
       CASE WHEN value = 17771 THEN 'needle-catalog-token' ELSE 'Series ' || value END,
       'ordinary synopsis',
       CASE WHEN value % 10 <> 0 THEN 'published' ELSE 'draft' END,
       CASE WHEN value % 10 <> 0 THEN CURRENT_TIMESTAMP - value * INTERVAL '1 second' END
FROM generate_series(1, 20000) value;
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose)
SELECT hash::uuid, 'poster/' || left(hash, 2) || '/' || hash || '.png',
       value || '.png', 'image/png', 1, 'poster'
FROM (
    SELECT value, md5('catalog-asset-' || value::text) AS hash
    FROM generate_series(1, 10000) value
) assets;
UPDATE movie
SET poster_asset_id = md5('catalog-asset-' || split_part(name, ' ', 2))::uuid
WHERE name ~ '^Movie [0-9]+$'
  AND split_part(name, ' ', 2)::integer <= 5000;
UPDATE series
SET poster_asset_id = md5('catalog-asset-' || (5000 + split_part(name, ' ', 2)::integer)::text)::uuid
WHERE name ~ '^Series [0-9]+$'
  AND split_part(name, ' ', 2)::integer <= 5000;
"#,
    )
    .await;
    // Model a maintained production catalog: VACUUM flushes GIN pending entries and updates
    // visibility/statistics before we inspect planner choices.
    sql(&db, "VACUUM ANALYZE movie").await;
    sql(&db, "VACUUM ANALYZE series").await;
    sql(&db, "VACUUM ANALYZE media_asset").await;

    let home_plan = explain(
        &db,
        "SELECT id FROM movie WHERE status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC, id LIMIT 20",
    )
    .await;
    assert!(
        home_plan.contains("movie_public_published_idx"),
        "{home_plan}"
    );
    assert!(home_plan.contains("Limit"), "{home_plan}");

    let search_plan = explain(
        &db,
        "SELECT id FROM series WHERE status = 'published' AND published_at IS NOT NULL AND lower(name) LIKE '%needle-catalog-token%' ESCAPE '!'",
    )
    .await;
    assert!(
        search_plan.contains("series_name_search_idx"),
        "{search_plan}"
    );
    assert!(
        search_plan.contains("Bitmap Index Scan") || search_plan.contains("Index Scan"),
        "{search_plan}"
    );

    let production_home_plan = explain_json_statement(
        &db,
        CATALOG_ITEMS_SQL,
        vec!["all".into(), 20_i64.into(), 0_i64.into(), 20_i64.into()],
    )
    .await;
    assert!(plan_uses_index(
        &production_home_plan,
        "movie_public_published_idx"
    ));
    assert!(plan_uses_index(
        &production_home_plan,
        "series_public_published_idx"
    ));
    assert_media_reads_are_bounded(&production_home_plan, 20);

    let production_search_plan = explain_statement(
        &db,
        CATALOG_SEARCH_ITEMS_SQL,
        vec![
            "all".into(),
            "%needle-catalog-token%".into(),
            20_i64.into(),
            0_i64.into(),
            20_i64.into(),
        ],
    )
    .await;
    assert!(
        production_search_plan.contains("movie_synopsis_search_idx"),
        "{production_search_plan}"
    );
    assert!(
        production_search_plan.contains("series_name_search_idx"),
        "{production_search_plan}"
    );

    migration::Migrator::down(&db, Some(3)).await.unwrap();
    let remaining = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            format!(
                "SELECT count(*) AS count FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ({index_names})"
            ),
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(remaining.try_get::<i64>("", "count").unwrap(), 0);
}

async fn explain(db: &DatabaseConnection, query: &str) -> String {
    explain_statement(db, query, Vec::new()).await
}

async fn explain_statement(
    db: &DatabaseConnection,
    query: &str,
    values: Vec<sea_orm::Value>,
) -> String {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("EXPLAIN {query}"),
            values,
        ))
        .await
        .unwrap();
    rows.into_iter()
        .map(|row| row.try_get::<String>("", "QUERY PLAN").unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

async fn explain_json_statement(
    db: &DatabaseConnection,
    query: &str,
    values: Vec<sea_orm::Value>,
) -> Value {
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("EXPLAIN (ANALYZE, FORMAT JSON) {query}"),
        values,
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get("", "QUERY PLAN")
    .unwrap()
}

fn plan_nodes<'a>(value: &'a Value, nodes: &mut Vec<&'a serde_json::Map<String, Value>>) {
    match value {
        Value::Object(object) => {
            if object.contains_key("Node Type") {
                nodes.push(object);
            }
            for child in object.values() {
                plan_nodes(child, nodes);
            }
        }
        Value::Array(values) => {
            for child in values {
                plan_nodes(child, nodes);
            }
        }
        _ => {}
    }
}

fn plan_uses_index(plan: &Value, expected: &str) -> bool {
    let mut nodes = Vec::new();
    plan_nodes(plan, &mut nodes);
    nodes
        .iter()
        .any(|node| node.get("Index Name").and_then(Value::as_str) == Some(expected))
}

fn assert_media_reads_are_bounded(plan: &Value, page_window: u64) {
    let mut nodes = Vec::new();
    plan_nodes(plan, &mut nodes);
    let media_nodes = nodes
        .into_iter()
        .filter(|node| node.get("Relation Name").and_then(Value::as_str) == Some("media_asset"))
        .collect::<Vec<_>>();
    assert!(
        !media_nodes.is_empty(),
        "no media_asset access in plan: {plan}"
    );
    for node in media_nodes {
        let node_type = node.get("Node Type").and_then(Value::as_str).unwrap_or("");
        let actual_rows = node.get("Actual Rows").and_then(Value::as_u64).unwrap_or(0);
        let actual_loops = node
            .get("Actual Loops")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        assert!(
            node_type.contains("Index") && actual_rows.saturating_mul(actual_loops) <= page_window,
            "media input was not bounded by page window {page_window}: {node:?}"
        );
    }
}
