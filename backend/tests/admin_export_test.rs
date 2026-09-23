mod support;

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{
        Request, StatusCode,
        header::{CONTENT_DISPOSITION, CONTENT_TYPE},
    },
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{app, config::Config};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait};
use serde_json::{Value, json};
use std::path::PathBuf;
use support::TestDatabase;
use tower::ServiceExt;
use uuid::Uuid;

const EXPORT_URI: &str = "/api/admin/contents/export";

struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn setup() -> (TestDatabase, TempRoot, Router, String) {
    let db = TestDatabase::migrated("admin_export").await;
    let root =
        TempRoot(std::env::temp_dir().join(format!("movie_harbor_export_{}", Uuid::new_v4())));
    let config = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.0.clone(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    };
    let app = app::build(db.connection(), &config).await.unwrap();
    let mut login = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"name":"Admin","password":"initial-password"}).to_string(),
        ))
        .unwrap();
    login.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(login).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (db, root, app, cookie)
}

async fn request(app: &Router, uri: &str, cookie: Option<&str>) -> Response {
    let mut request = Request::builder().uri(uri).header("host", "harbor.test");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn seed(db: &DatabaseConnection) {
    db.execute_unprepared(r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('a0000000-0000-0000-0000-000000000001', 'poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'movie.png', 'image/png', 1, 'poster'),
('a0000000-0000-0000-0000-000000000002', 'video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4', 'movie.mp4', 'video/mp4', 1, 'video'),
('a0000000-0000-0000-0000-000000000003', 'poster/cc/cccccccccccccccccccccccccccccccc.jpg', 'series.jpg', 'image/jpeg', 1, 'poster'),
('a0000000-0000-0000-0000-000000000004', 'video/dd/dddddddddddddddddddddddddddddddd.webm', 'episode.webm', 'video/webm', 1, 'video');
INSERT INTO movie (id, name, synopsis, year, status, poster_asset_id, video_asset_id, duration_seconds) VALUES
('10000000-0000-0000-0000-000000000003', 'Zulu', 'archived movie', NULL, 'archived', NULL, NULL, NULL),
('10000000-0000-0000-0000-000000000002', 'Alpha', 'published movie', NULL, 'published', NULL, NULL, NULL),
('10000000-0000-0000-0000-000000000001', 'Alpha', 'draft movie', 2024, 'draft', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 123);
INSERT INTO series (id, name, synopsis, year, status, poster_asset_id) VALUES
('20000000-0000-0000-0000-000000000003', 'Zulu', 'archived series', NULL, 'archived', NULL),
('20000000-0000-0000-0000-000000000002', 'Alpha', 'published series', NULL, 'published', NULL),
('20000000-0000-0000-0000-000000000001', 'Alpha', 'draft series', 2023, 'draft', 'a0000000-0000-0000-0000-000000000003');
INSERT INTO season (id, series_id, number) VALUES
('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2),
('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 1),
('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 1);
INSERT INTO episode (id, season_id, number, name, status, video_asset_id, duration_seconds) VALUES
('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'Season two', 'archived', NULL, NULL),
('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 2, 'Second', 'published', NULL, NULL),
('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000002', 1, 'First', 'draft', 'a0000000-0000-0000-0000-000000000004', 45),
('40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', 1, 'Hidden parent episode', 'published', NULL, NULL);
UPDATE genre SET enabled = false
WHERE id = '00000000-0000-0000-0001-000000000004';
UPDATE genre SET sort_order = CASE id
    WHEN '00000000-0000-0000-0001-000000000001'::uuid THEN 30
    WHEN '00000000-0000-0000-0001-000000000003'::uuid THEN 10
    WHEN '00000000-0000-0000-0001-000000000004'::uuid THEN 10
    WHEN '00000000-0000-0000-0001-000000000005'::uuid THEN 30
    WHEN '00000000-0000-0000-0001-000000000006'::uuid THEN 10
    WHEN '00000000-0000-0000-0001-000000000007'::uuid THEN 10
END
WHERE id IN (
    '00000000-0000-0000-0001-000000000001',
    '00000000-0000-0000-0001-000000000003',
    '00000000-0000-0000-0001-000000000004',
    '00000000-0000-0000-0001-000000000005',
    '00000000-0000-0000-0001-000000000006',
    '00000000-0000-0000-0001-000000000007'
);
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000004'),
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001'),
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000003');
INSERT INTO series_genre (series_id, genre_id) VALUES
('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000007'),
('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000005'),
('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000006');
"#).await.unwrap();
}

// Catches missing authentication and loss of the download response contract.
#[tokio::test]
async fn export_requires_authentication_and_returns_timestamped_json_attachment() {
    let (_db, _root, app, cookie) = setup().await;
    let before = chrono::Utc::now();
    let response = request(&app, EXPORT_URI, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    let disposition = response.headers()[CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .to_owned();
    let payload = body(response).await;
    let exported_at =
        chrono::DateTime::parse_from_rfc3339(payload["exported_at"].as_str().unwrap()).unwrap();
    assert!(exported_at >= before && exported_at <= chrono::Utc::now());
    assert_eq!(exported_at.offset().local_minus_utc(), 0);
    assert_eq!(
        disposition,
        format!(
            "attachment; filename=\"movie-harbor-content-export-{}.json\"",
            exported_at.format("%Y%m%d-%H%M%S")
        )
    );
    assert_eq!(
        payload,
        json!({"exported_at": payload["exported_at"], "movies": [], "series": []})
    );
    assert_eq!(
        request(&app, EXPORT_URI, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, EXPORT_URI, Some("session=invalid"))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

// Exact payloads catch leaked IDs/status, missing states, incorrect grouping, and genre ordering:
// both content kinds need sort_order before ID, then ID to break equal sort_order ties.
#[tokio::test]
async fn export_includes_all_states_with_exact_fields_flat_episodes_and_stable_order() {
    let (db, _root, app, cookie) = setup().await;
    seed(&db).await;
    let response = request(&app, EXPORT_URI, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = body(response).await;
    assert_eq!(
        payload,
        json!({
            "exported_at": payload["exported_at"],
            "movies": [
                {"name":"Alpha","synopsis":"draft movie","year":2024,"genres":["动作","科幻","剧情"],"poster_path":"/media/poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png","video_path":"/media/video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4","duration_seconds":123},
                {"name":"Alpha","synopsis":"published movie","year":null,"genres":[],"poster_path":null,"video_path":null,"duration_seconds":null},
                {"name":"Zulu","synopsis":"archived movie","year":null,"genres":[],"poster_path":null,"video_path":null,"duration_seconds":null}
            ],
            "series": [
                {"name":"Alpha","synopsis":"draft series","year":2023,"genres":["悬疑","犯罪","恐怖"],"poster_path":"/media/poster/cc/cccccccccccccccccccccccccccccccc.jpg","episodes":[
                    {"season_number":1,"episode_number":1,"name":"First","video_path":"/media/video/dd/dddddddddddddddddddddddddddddddd.webm","duration_seconds":45},
                    {"season_number":1,"episode_number":2,"name":"Second","video_path":null,"duration_seconds":null},
                    {"season_number":2,"episode_number":1,"name":"Season two","video_path":null,"duration_seconds":null}
                ]},
                {"name":"Alpha","synopsis":"published series","year":null,"genres":[],"poster_path":null,"episodes":[]},
                {"name":"Zulu","synopsis":"archived series","year":null,"genres":[],"poster_path":null,"episodes":[
                    {"season_number":1,"episode_number":1,"name":"Hidden parent episode","video_path":null,"duration_seconds":null}
                ]}
            ]
        })
    );
}

// Catches accidentally reusing a single page or applying the current list filters.
#[tokio::test]
async fn export_is_complete_beyond_one_page_and_ignores_list_filters() {
    let (db, _root, app, cookie) = setup().await;
    db.execute_unprepared("INSERT INTO movie (id, name) SELECT md5('movie-' || n)::uuid, 'Movie ' || n FROM generate_series(1, 25) n; INSERT INTO series (id, name) SELECT md5('series-' || n)::uuid, 'Series ' || n FROM generate_series(1, 25) n;").await.unwrap();
    let response = request(
        &app,
        "/api/admin/contents/export?kind=movie&status=published&name=missing&page=2",
        Some(&cookie),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = body(response).await;
    assert_eq!(payload["movies"].as_array().unwrap().len(), 25);
    assert_eq!(payload["series"].as_array().unwrap().len(), 25);
}

// Catches turning invalid stored paths into null or disclosing raw database/path errors.
#[tokio::test]
async fn export_fails_closed_for_invalid_paths_in_every_media_slot() {
    let (db, _root, app, cookie) = setup().await;
    seed(&db).await;
    for (id, key) in [
        (
            "a0000000-0000-0000-0000-000000000001",
            "poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        ),
        (
            "a0000000-0000-0000-0000-000000000002",
            "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4",
        ),
        (
            "a0000000-0000-0000-0000-000000000003",
            "poster/cc/cccccccccccccccccccccccccccccccc.jpg",
        ),
        (
            "a0000000-0000-0000-0000-000000000004",
            "video/dd/dddddddddddddddddddddddddddddddd.webm",
        ),
    ] {
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE media_asset SET storage_key = '../private/secret' WHERE id = $1::uuid",
            [id.into()],
        ))
        .await
        .unwrap();
        let response = request(&app, EXPORT_URI, Some(&cookie)).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body(response).await,
            json!({"error":"internal server error"})
        );
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE media_asset SET storage_key = $2 WHERE id = $1::uuid",
            [id.into(), key.into()],
        ))
        .await
        .unwrap();
    }
    db.execute_unprepared("ALTER TABLE movie RENAME COLUMN synopsis TO unavailable_synopsis")
        .await
        .unwrap();
    let response = request(&app, EXPORT_URI, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body(response).await,
        json!({"error":"internal server error"})
    );
}

async fn wait_for_locked_query(db: &DatabaseConnection, relation: &str) -> bool {
    for _ in 0..300 {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN pg_locks lock ON lock.pid = activity.pid
    WHERE activity.wait_event_type = 'Lock'
      AND lock.locktype = 'relation' AND NOT lock.granted
      AND lock.relation = to_regclass($1)::oid
) AS blocked
"#,
                [relation.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        if row.try_get::<bool>("", "blocked").unwrap() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

// Read committed would combine old parent metadata with newly committed genres and media paths.
#[tokio::test]
async fn export_content_genres_and_media_share_one_snapshot() {
    let (db, _root, app, cookie) = setup().await;
    seed(&db).await;
    let blocker = db.begin().await.unwrap();
    blocker
        .execute_unprepared("LOCK TABLE movie_genre IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let read_app = app.clone();
    let read_cookie = cookie.clone();
    let export_task =
        tokio::spawn(async move { request(&read_app, EXPORT_URI, Some(&read_cookie)).await });
    if !wait_for_locked_query(&db, "movie_genre").await {
        blocker.rollback().await.unwrap();
        export_task.abort();
        let _ = export_task.await;
        panic!("export did not wait for the locked movie_genre table");
    }
    blocker.execute_unprepared(r#"
UPDATE movie SET synopsis = 'concurrent movie' WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE movie SET year = 2025 WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE series SET synopsis = 'concurrent series' WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE episode SET name = 'concurrent episode' WHERE id = '40000000-0000-0000-0000-000000000003';
UPDATE genre SET name = 'concurrent genre' WHERE id = '00000000-0000-0000-0001-000000000004';
UPDATE media_asset SET storage_key = 'video/ee/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.mp4' WHERE id = 'a0000000-0000-0000-0000-000000000002';
UPDATE media_asset SET storage_key = 'video/ff/ffffffffffffffffffffffffffffffff.webm' WHERE id = 'a0000000-0000-0000-0000-000000000004';
"#).await.unwrap();
    blocker.commit().await.unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(3), export_task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload = body(response).await;
    assert_eq!(payload["movies"][0]["synopsis"], "draft movie");
    assert_eq!(payload["movies"][0]["year"], 2024);
    assert_eq!(
        payload["movies"][0]["genres"],
        json!(["动作", "科幻", "剧情"])
    );
    assert_eq!(
        payload["movies"][0]["video_path"],
        "/media/video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4"
    );
    assert_eq!(payload["series"][0]["synopsis"], "draft series");
    assert_eq!(payload["series"][0]["episodes"][0]["name"], "First");
    assert_eq!(
        payload["series"][0]["episodes"][0]["video_path"],
        "/media/video/dd/dddddddddddddddddddddddddddddddd.webm"
    );
    let fresh = body(request(&app, EXPORT_URI, Some(&cookie)).await).await;
    assert_eq!(fresh["movies"][0]["synopsis"], "concurrent movie");
    assert_eq!(fresh["movies"][0]["year"], 2025);
    assert_eq!(
        fresh["movies"][0]["genres"],
        json!(["动作", "concurrent genre", "剧情"])
    );
    assert_eq!(
        fresh["movies"][0]["video_path"],
        "/media/video/ee/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.mp4"
    );
    assert_eq!(fresh["series"][0]["synopsis"], "concurrent series");
    assert_eq!(
        fresh["series"][0]["episodes"][0]["name"],
        "concurrent episode"
    );
    assert_eq!(
        fresh["series"][0]["episodes"][0]["video_path"],
        "/media/video/ff/ffffffffffffffffffffffffffffffff.webm"
    );
}
