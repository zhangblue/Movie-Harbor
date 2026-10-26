use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use image::ImageEncoder;
use movie_harbor_api::{app, auth::csrf, config::Config};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use serde_json::Value;
use tower::ServiceExt;
mod support;
const KEY: &str = "staged-poster-test-key";
fn config(root: std::path::PathBuf) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root,
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
    }
}
async fn setup() -> (support::TestDatabase, Router, std::path::PathBuf) {
    let db = support::TestDatabase::migrated("staged_poster").await;
    let root = std::env::temp_dir().join(format!("staged_poster_{}", uuid::Uuid::new_v4()));
    let router = app::build(db.connection(), &config(root.clone()))
        .await
        .unwrap();
    (db, router, root)
}
fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&[24, 48, 96], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}
async fn stage(app: &Router, name: &str, mime: &str, bytes: &[u8]) -> Response {
    let mut body = format!("--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend(bytes);
    body.extend(b"\r\n--boundary--\r\n");
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/admin/media/posters/stage")
                .header("host", "harbor.test")
                .header("authorization", format!("Bearer {KEY}"))
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn count(db: &support::TestDatabase, table: &str) -> i64 {
    db.query_one(Statement::from_string(
        DbBackend::Postgres,
        format!("SELECT count(*) AS count FROM {table}"),
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get("", "count")
    .unwrap()
}
// Catches forgetting migration registration and token/asset unique constraints.
#[tokio::test]
async fn staging_schema_upgrade_and_unique_constraints() {
    let db = support::TestDatabase::at_migration("staged_upgrade", Some(6)).await;
    migration::Migrator::up(&*db, None).await.unwrap();
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_regclass('mcp_staged_poster')::text AS table_name",
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(
        row.try_get::<Option<String>>("", "table_name")
            .unwrap()
            .is_some(),
        "staging migration must create table"
    );
    db.execute_unprepared("INSERT INTO media_asset(id,storage_key,original_name,mime_type,byte_size,purpose) VALUES ('10000000-0000-4000-8000-000000000001','poster/a.png','a.png','image/png',1,'poster'),('10000000-0000-4000-8000-000000000002','poster/b.png','b.png','image/png',1,'poster')").await.unwrap();
    db.execute_unprepared("INSERT INTO mcp_staged_poster(id,token_hash,principal_hash,asset_id,created_at,expires_at) VALUES(gen_random_uuid(),'hash-a','principal','10000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 minutes')").await.unwrap();
    for (token, asset) in [
        ("hash-a", "10000000-0000-4000-8000-000000000002"),
        ("hash-b", "10000000-0000-4000-8000-000000000001"),
    ] {
        let error = db.execute_unprepared(&format!("INSERT INTO mcp_staged_poster(id,token_hash,principal_hash,asset_id,created_at,expires_at) VALUES(gen_random_uuid(),'{token}','principal','{asset}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 minutes')")).await.unwrap_err();
        let sea_orm::DbErr::Exec(sea_orm::RuntimeErr::SqlxError(error)) = error else {
            panic!("expected PostgreSQL uniqueness error: {error}");
        };
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23505")
        );
    }
    assert!(migration::Migrator::down(&*db, Some(1)).await.is_err());
    assert_eq!(count(&db, "mcp_staged_poster").await, 1);
    db.execute_unprepared("DELETE FROM mcp_staged_poster")
        .await
        .unwrap();
    migration::Migrator::down(&*db, Some(1)).await.unwrap();
    migration::Migrator::up(&*db, None).await.unwrap();
}
// Catches missing route, cache protection, and raw token persistence.
#[tokio::test]
async fn stage_returns_only_once_token_and_validated_metadata() {
    let (db, app, root) = setup().await;
    let image = png();
    let response = stage(&app, "poster.png", "image/png", &image).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let response = body(response).await;
    let token = response["token"].as_str().unwrap();
    assert!(token.starts_with("mhposter_"));
    assert_eq!(token.len(), 73);
    assert!(
        token[9..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert_eq!(response["format"], "png");
    assert_eq!(response["byte_size"], image.len());
    assert_eq!(count(&db, "media_asset").await, 1);
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT token_hash,principal_hash,created_at,expires_at FROM mcp_staged_poster",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<String>("", "token_hash").unwrap(),
        csrf::digest(token)
    );
    assert_eq!(
        row.try_get::<String>("", "principal_hash").unwrap(),
        csrf::digest(KEY)
    );
    let created_at = row
        .try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at")
        .unwrap();
    let expires_at = row
        .try_get::<chrono::DateTime<chrono::FixedOffset>>("", "expires_at")
        .unwrap();
    assert_eq!((expires_at - created_at).num_seconds(), 1800);
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(response["expires_at"].as_str().unwrap())
            .unwrap()
            .timestamp(),
        expires_at.timestamp()
    );
    std::fs::remove_dir_all(root).unwrap();
}
// Catches bypassing image validation and upload byte limits.
#[tokio::test]
async fn invalid_images_types_and_upload_limits_leave_no_assets() {
    let (db, app, root) = setup().await;
    for (name, mime, bytes, status) in [
        (
            "bad.png",
            "image/png",
            b"broken".to_vec(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "bad.jpg",
            "image/png",
            png(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "bad.png",
            "image/jpeg",
            png(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "large.png",
            "image/png",
            vec![0; 1025],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        assert_eq!(stage(&app, name, mime, &bytes).await.status(), status);
        assert_eq!(count(&db, "media_asset").await, 0);
    }
    std::fs::remove_dir_all(root).unwrap();
}
// Catches admitting authenticated administrator cookies to MCP-only operation.
#[tokio::test]
async fn administrator_with_valid_csrf_is_forbidden() {
    let (db, app, root) = setup().await;
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"name":"Admin","password":"initial-password"}"#,
        ))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/session")
                .header("host", "harbor.test")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let csrf = body(response).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/admin/media/posters/stage")
                .header("host", "harbor.test")
                .header("origin", "https://harbor.test")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from("--boundary--\r\n"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(count(&db, "media_asset").await, 0);
    std::fs::remove_dir_all(root).unwrap();
}

use chrono::Utc;
use movie_harbor_api::media::{
    self, ChunkSource, LocalMediaStorage, MediaError, UploadPolicy,
    staged_poster::{self, StagePosterCommand, StagedPosterError},
};
use sea_orm::TransactionTrait;
struct Source(Option<axum::body::Bytes>);
impl ChunkSource for Source {
    fn next_chunk(
        &mut self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Option<axum::body::Bytes>, MediaError>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async move { Ok(self.0.take()) })
    }
}
async fn staged(
    db: &support::TestDatabase,
    storage: &LocalMediaStorage,
) -> staged_poster::StagedPosterResponse {
    staged_poster::stage(StagePosterCommand {
        db,
        storage,
        policy: &UploadPolicy::new(1024, ["video/mp4"]).unwrap(),
        principal_hash: &csrf::digest(KEY),
        original_name: "poster.png",
        declared_mime: "image/png",
        source: Source(Some(png().into())),
    })
    .await
    .unwrap()
}
// Catches consuming another principal's token, replay, and consuming on a failed outer transaction.
#[tokio::test]
async fn consumption_is_principal_bound_once_and_rolls_back_with_caller() {
    let db = support::TestDatabase::migrated("staged_consume").await;
    let root = std::env::temp_dir().join(format!("staged_consume_{}", uuid::Uuid::new_v4()));
    let storage = LocalMediaStorage::initialize(&root).await.unwrap();
    let response = staged(&db, &storage).await;
    let principal = csrf::digest(KEY);
    let now = Utc::now().fixed_offset();
    assert!(matches!(
        staged_poster::lock_for_consumption(&*db, &response.token, "other-principal", now).await,
        Err(StagedPosterError::NotFound)
    ));
    let tx = db.begin().await.unwrap();
    let consumed = staged_poster::lock_for_consumption(&tx, &response.token, &principal, now)
        .await
        .unwrap();
    assert!(
        storage
            .is_accessible_regular_file(&consumed.asset.storage_key)
            .unwrap()
    );
    assert!(matches!(
        staged_poster::lock_for_consumption(&tx, &response.token, &principal, now).await,
        Err(StagedPosterError::NotFound)
    ));
    tx.rollback().await.unwrap();
    let tx = db.begin().await.unwrap();
    assert_eq!(
        staged_poster::lock_for_consumption(&tx, &response.token, &principal, now)
            .await
            .unwrap()
            .asset
            .id,
        consumed.asset.id
    );
    tx.commit().await.unwrap();
    assert!(matches!(
        staged_poster::lock_for_consumption(&*db, &response.token, &principal, now).await,
        Err(StagedPosterError::NotFound)
    ));
    assert_eq!(count(&db, "media_asset").await, 1);
    std::fs::remove_dir_all(root).unwrap();
}
// Catches broad orphan scans, expiry boundary errors, ignoring limit, or touching consumed assets.
#[tokio::test]
async fn expiry_cleanup_is_bounded_and_only_deletes_recorded_staging_assets() {
    let db = support::TestDatabase::migrated("staged_expiry").await;
    let root = std::env::temp_dir().join(format!("staged_expiry_{}", uuid::Uuid::new_v4()));
    let storage = LocalMediaStorage::initialize(&root).await.unwrap();
    let a = staged(&db, &storage).await;
    let b = staged(&db, &storage).await;
    let _fresh = staged(&db, &storage).await;
    let untracked = media::store_new_asset(
        &db,
        &storage,
        media::MediaKind::Poster,
        "orphan.png",
        "image/png",
        &UploadPolicy::new(1024, ["video/mp4"]).unwrap(),
        Source(Some(png().into())),
    )
    .await
    .unwrap();
    let now = Utc::now().fixed_offset();
    for response in [&a, &b] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE mcp_staged_poster SET expires_at=$1 WHERE token_hash=$2",
            [now.into(), csrf::digest(&response.token).into()],
        ))
        .await
        .unwrap();
    }
    let expired_keys: Vec<String> = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT a.storage_key FROM media_asset a JOIN mcp_staged_poster s ON s.asset_id=a.id WHERE s.expires_at <= $1",
        [now.into()],
    )).await.unwrap().into_iter().map(|row| row.try_get("", "storage_key").unwrap()).collect();
    let unrelated_path = root.join("poster/unregistered.keep");
    std::fs::write(&unrelated_path, b"unregistered file must survive cleanup").unwrap();
    assert!(matches!(
        staged_poster::lock_for_consumption(&*db, &a.token, &csrf::digest(KEY), now).await,
        Err(StagedPosterError::NotFound)
    ));
    assert_eq!(
        staged_poster::cleanup_expired(&db, &storage, now, 0)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        staged_poster::cleanup_expired(&db, &storage, now, 1)
            .await
            .unwrap(),
        1
    );
    assert_eq!(count(&db, "mcp_staged_poster").await, 2);
    assert_eq!(count(&db, "media_asset").await, 3);
    assert_eq!(
        staged_poster::cleanup_expired(&db, &storage, now, 10)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        staged_poster::cleanup_expired(&db, &storage, now, 10)
            .await
            .unwrap(),
        0
    );
    assert!(
        storage
            .is_accessible_regular_file(&untracked.storage_key)
            .unwrap()
    );
    for key in expired_keys {
        assert!(!root.join(key).exists());
    }
    assert_eq!(
        std::fs::read(&unrelated_path).unwrap(),
        b"unregistered file must survive cleanup"
    );
    std::fs::remove_dir_all(root).unwrap();
}
// Catches omitting opportunistic cleanup or the one-time startup cleanup.
#[tokio::test]
async fn stage_and_startup_cleanup_expired_records() {
    let (db, app, root) = setup().await;
    assert_eq!(
        stage(&app, "a.png", "image/png", &png()).await.status(),
        StatusCode::CREATED
    );
    db.execute_unprepared(
        "UPDATE mcp_staged_poster SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute'",
    )
    .await
    .unwrap();
    assert_eq!(
        stage(&app, "b.png", "image/png", &png()).await.status(),
        StatusCode::CREATED
    );
    assert_eq!(count(&db, "mcp_staged_poster").await, 1);
    assert_eq!(count(&db, "media_asset").await, 1);
    db.execute_unprepared(
        "UPDATE mcp_staged_poster SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute'",
    )
    .await
    .unwrap();
    let _app = app::build(db.connection(), &config(root.clone()))
        .await
        .unwrap();
    assert_eq!(count(&db, "mcp_staged_poster").await, 0);
    assert_eq!(count(&db, "media_asset").await, 0);
    std::fs::remove_dir_all(root).unwrap();
}

// Catches committing the first file before discovering an extra multipart field.
#[tokio::test]
async fn multipart_requires_exactly_one_file_and_cleans_prepared_files_on_rejection() {
    let (db, app, root) = setup().await;
    for tail in [
        "Content-Disposition: form-data; name=\"extra\"\r\n\r\nignored",
        "Content-Disposition: form-data; name=\"file\"; filename=\"second.png\"\r\nContent-Type: image/png\r\n\r\nbroken",
    ] {
        let mut bytes=b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"poster.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
        bytes.extend(png());
        bytes.extend(format!("\r\n--boundary\r\n{tail}\r\n--boundary--\r\n").as_bytes());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/media/posters/stage")
                    .header("host", "harbor.test")
                    .header("authorization", format!("Bearer {KEY}"))
                    .header("content-type", "multipart/form-data; boundary=boundary")
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(count(&db, "media_asset").await, 0);
        assert_eq!(count(&db, "mcp_staged_poster").await, 0);
        assert!(
            std::fs::read_dir(root.join(".incoming"))
                .unwrap()
                .next()
                .is_none()
        );
        assert!(
            std::fs::read_dir(root.join("poster"))
                .unwrap()
                .all(|entry| std::fs::read_dir(entry.unwrap().path())
                    .unwrap()
                    .next()
                    .is_none())
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

// Catches missing FOR UPDATE / row-count checks allowing concurrent token replay.
#[tokio::test]
async fn concurrent_consumption_has_one_winner() {
    let db = support::TestDatabase::migrated("staged_concurrent").await;
    let root = std::env::temp_dir().join(format!("staged_concurrent_{}", uuid::Uuid::new_v4()));
    let storage = LocalMediaStorage::initialize(&root).await.unwrap();
    let response = staged(&db, &storage).await;
    let run = || {
        let db = db.connection();
        let token = response.token.clone();
        async move {
            let tx = db.begin().await.unwrap();
            let result = staged_poster::lock_for_consumption(
                &tx,
                &token,
                &csrf::digest(KEY),
                Utc::now().fixed_offset(),
            )
            .await;
            tx.commit().await.unwrap();
            result
        }
    };
    let (a, b) = tokio::join!(run(), run());
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(StagedPosterError::NotFound))
            || matches!(b, Err(StagedPosterError::NotFound))
    );
    std::fs::remove_dir_all(root).unwrap();
}
// Catches committing staged-row deletion before media deletion or failing to restore isolated files.
#[tokio::test]
async fn cleanup_operation_error_restores_and_commit_error_waits_for_recovery() {
    let db = support::TestDatabase::migrated("staged_cleanup_failure").await;
    let root =
        std::env::temp_dir().join(format!("staged_cleanup_failure_{}", uuid::Uuid::new_v4()));
    let storage = LocalMediaStorage::initialize(&root).await.unwrap();
    let _response = staged(&db, &storage).await;
    db.execute_unprepared("UPDATE mcp_staged_poster SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute'; CREATE FUNCTION reject_staged_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected deletion failure'; END $$").await.unwrap();
    for trigger in [
        "CREATE TRIGGER reject_staged_delete BEFORE DELETE ON media_asset FOR EACH ROW EXECUTE FUNCTION reject_staged_delete()",
        "CREATE CONSTRAINT TRIGGER reject_staged_delete AFTER DELETE ON media_asset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_staged_delete()",
    ] {
        db.execute_unprepared(trigger).await.unwrap();
        assert!(
            staged_poster::cleanup_expired(&db, &storage, Utc::now().fixed_offset(), 25)
                .await
                .is_err()
        );
        assert_eq!(count(&db, "mcp_staged_poster").await, 1);
        assert_eq!(count(&db, "media_asset").await, 1);
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT storage_key FROM media_asset",
            ))
            .await
            .unwrap()
            .unwrap();
        if trigger.starts_with("CREATE CONSTRAINT") {
            assert!(
                !root
                    .join(row.try_get::<String>("", "storage_key").unwrap())
                    .exists()
            );
            let operations: Vec<_> = std::fs::read_dir(root.join(".operations"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            assert_eq!(operations.len(), 1);
            assert!(operations[0].join("manifest.json").is_file());
            media::removal::recover(&db, &storage).await.unwrap();
        }
        assert!(
            storage
                .is_accessible_regular_file(&row.try_get::<String>("", "storage_key").unwrap())
                .unwrap()
        );
        assert!(
            std::fs::read_dir(root.join(".operations"))
                .unwrap()
                .next()
                .is_none()
        );
        db.execute_unprepared("DROP TRIGGER reject_staged_delete ON media_asset")
            .await
            .unwrap();
    }
    assert_eq!(
        staged_poster::cleanup_expired(&db, &storage, Utc::now().fixed_offset(), 25)
            .await
            .unwrap(),
        1
    );
    std::fs::remove_dir_all(root).unwrap();
}
// Catches changing the new-stage/startup batch bounds or looping until all staging rows disappear.
#[tokio::test]
async fn stage_and_startup_cleanup_have_finite_batch_bounds() {
    let (db, app, root) = setup().await;
    db.execute_unprepared("INSERT INTO media_asset(id,storage_key,original_name,mime_type,byte_size,purpose) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'poster/'||left(md5(i::text),2)||'/'||md5(i::text)||'.png','poster.png','image/png',1,'poster' FROM generate_series(1,1027) AS i; INSERT INTO mcp_staged_poster(id,token_hash,principal_hash,asset_id,created_at,expires_at) SELECT gen_random_uuid(),id::text,'principal',id,CURRENT_TIMESTAMP-INTERVAL '1 hour',CURRENT_TIMESTAMP-INTERVAL '1 minute' FROM media_asset").await.unwrap();
    assert_eq!(
        stage(&app, "poster.png", "image/png", &png())
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(count(&db, "mcp_staged_poster").await, 1003);
    let _rebuilt = app::build(db.connection(), &config(root.clone()))
        .await
        .unwrap();
    assert_eq!(count(&db, "mcp_staged_poster").await, 3);
    assert_eq!(count(&db, "media_asset").await, 3);
    std::fs::remove_dir_all(root).unwrap();
}

// Catches treating missing upload metadata as an unsupported media format or accepting a non-file field.
#[tokio::test]
async fn multipart_missing_metadata_or_wrong_field_is_bad_request() {
    let (db, app, root) = setup().await;
    for headers in [
        "Content-Disposition: form-data; name=\"file\"; filename=\"poster.png\"",
        "Content-Disposition: form-data; name=\"file\"\r\nContent-Type: image/png",
        "Content-Disposition: form-data; name=\"wrong\"; filename=\"poster.png\"\r\nContent-Type: image/png",
    ] {
        let mut bytes = format!("--boundary\r\n{headers}\r\n\r\n").into_bytes();
        bytes.extend(png());
        bytes.extend(b"\r\n--boundary--\r\n");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/media/posters/stage")
                    .header("host", "harbor.test")
                    .header("authorization", format!("Bearer {KEY}"))
                    .header("content-type", "multipart/form-data; boundary=boundary")
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(count(&db, "media_asset").await, 0);
        assert_eq!(count(&db, "mcp_staged_poster").await, 0);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
struct DenyCleanupFinalize {
    root: std::path::PathBuf,
}
#[cfg(unix)]
impl media::StorageHooks for DenyCleanupFinalize {
    fn on_event(&self, event: &media::StorageEvent) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        if matches!(event, media::StorageEvent::AfterStageRename(_)) {
            for entry in std::fs::read_dir(self.root.join(".operations"))? {
                let directory = entry?.path();
                if directory.is_dir() {
                    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o500))?;
                }
            }
        }
        Ok(())
    }
}
// Catches claiming cleanup success or removing the recovery manifest after physical finalization fails.
#[cfg(unix)]
#[tokio::test]
async fn cleanup_finalization_failure_retains_manifest_for_startup_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let db = support::TestDatabase::migrated("staged_finalize_failure").await;
    let root =
        std::env::temp_dir().join(format!("staged_finalize_failure_{}", uuid::Uuid::new_v4()));
    let storage = LocalMediaStorage::initialize_with_hooks(
        &root,
        std::sync::Arc::new(DenyCleanupFinalize { root: root.clone() }),
    )
    .await
    .unwrap();
    let _response = staged(&db, &storage).await;
    db.execute_unprepared(
        "UPDATE mcp_staged_poster SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute'",
    )
    .await
    .unwrap();
    assert!(
        staged_poster::cleanup_expired(&db, &storage, Utc::now().fixed_offset(), 25)
            .await
            .is_err()
    );
    assert_eq!(count(&db, "mcp_staged_poster").await, 0);
    assert_eq!(count(&db, "media_asset").await, 0);
    let operations: Vec<_> = std::fs::read_dir(root.join(".operations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(operations.len(), 1);
    assert!(operations[0].join("manifest.json").is_file());
    std::fs::set_permissions(&operations[0], std::fs::Permissions::from_mode(0o700)).unwrap();
    media::removal::recover(&db, &storage).await.unwrap();
    assert!(
        std::fs::read_dir(root.join(".operations"))
            .unwrap()
            .next()
            .is_none()
    );
    std::fs::remove_dir_all(root).unwrap();
}

async fn mcp_post(app: &Router, path: &str, payload: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("host", "harbor.test")
                .header("authorization", format!("Bearer {KEY}"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn complete_draft(db: &support::TestDatabase, app: &Router) -> (Value, String) {
    let genre = uuid::Uuid::new_v4();
    db.execute_unprepared(&format!(
        "INSERT INTO genre(id,name,enabled) VALUES ('{genre}','{genre}',true)"
    ))
    .await
    .unwrap();
    let staged = stage(app, "poster.png", "image/png", &png()).await;
    assert_eq!(staged.status(), StatusCode::CREATED);
    let token = body(staged).await["token"].as_str().unwrap().to_owned();
    let asset: uuid::Uuid = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT asset_id FROM mcp_staged_poster WHERE token_hash=$1",
            [csrf::digest(&token).into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "asset_id")
        .unwrap();
    (
        serde_json::json!({"name":"示例电影", "synopsis":"一段完整简介。", "is_private":true, "year":2024,
        "duration_seconds":7200,"genre_ids":[genre],"staged_poster_token":token}),
        asset.to_string(),
    )
}

// Catches MCP creation accepting synopsis in JSON but discarding it before persistence.
#[tokio::test]
async fn mcp_private_movie_and_series_persist_synopsis() {
    let (db, app, root) = setup().await;
    for (path, table) in [
        ("/api/admin/movies", "movie"),
        ("/api/admin/series", "series"),
    ] {
        let (payload, _) = complete_draft(&db, &app).await;
        let response = mcp_post(&app, path, payload).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let result = body(response).await;
        assert_eq!(result["synopsis"], "一段完整简介。");
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("SELECT synopsis,is_private FROM {table} WHERE id=$1"),
                [uuid::Uuid::parse_str(result["id"].as_str().unwrap())
                    .unwrap()
                    .into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.try_get::<String>("", "synopsis").unwrap(),
            "一段完整简介。"
        );
        assert!(row.try_get::<bool>("", "is_private").unwrap());
    }
    std::fs::remove_dir_all(root).unwrap();
}

// Catches MCP creation rejecting public drafts or silently forcing them private.
#[tokio::test]
async fn mcp_public_movie_and_series_persist_requested_visibility() {
    let (db, app, root) = setup().await;
    for (path, table) in [
        ("/api/admin/movies", "movie"),
        ("/api/admin/series", "series"),
    ] {
        let (mut payload, _) = complete_draft(&db, &app).await;
        payload["is_private"] = serde_json::json!(false);
        let response = mcp_post(&app, path, payload).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let result = body(response).await;
        assert_eq!(result["is_private"], false);
        assert_eq!(result["synopsis"], "一段完整简介。");
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("SELECT synopsis,is_private FROM {table} WHERE id=$1"),
                [uuid::Uuid::parse_str(result["id"].as_str().unwrap())
                    .unwrap()
                    .into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.try_get::<String>("", "synopsis").unwrap(),
            "一段完整简介。"
        );
        assert!(!row.try_get::<bool>("", "is_private").unwrap());
    }
    std::fs::remove_dir_all(root).unwrap();
}
// Catches partial drafts, discarded metadata, missing ownership, and reusable tokens.
#[tokio::test]
async fn mcp_complete_movie_and_series_atomically_consume_posters() {
    let (db, app, root) = setup().await;
    for (path, table) in [
        ("/api/admin/movies", "movie"),
        ("/api/admin/series", "series"),
    ] {
        let (payload, asset) = complete_draft(&db, &app).await;
        let response = mcp_post(&app, path, payload.clone()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let result = body(response).await;
        assert_eq!(result["poster"]["id"], asset);
        assert_eq!(result["year"], 2024);
        assert_eq!(result["synopsis"], "一段完整简介。");
        assert_eq!(result["genres"][0]["id"], payload["genre_ids"][0]);
        assert_eq!(result["is_private"], true);
        assert_eq!(result["status"], "draft");
        assert_eq!(result["version"], 1);
        if table == "movie" {
            assert_eq!(result["duration_seconds"], 7200);
        }
        assert_eq!(count(&db, "mcp_staged_poster").await, 0);
        assert_eq!(count(&db, table).await, 1);
        assert_eq!(count(&db, &format!("{table}_genre")).await, 1);
        let owner = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT owner_kind,owner_id,slot FROM media_asset_ownership WHERE asset_id=$1",
                [uuid::Uuid::parse_str(&asset).unwrap().into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.try_get::<String>("", "owner_kind").unwrap(), table);
        assert_eq!(
            owner
                .try_get::<uuid::Uuid>("", "owner_id")
                .unwrap()
                .to_string(),
            result["id"]
        );
        assert_eq!(owner.try_get::<String>("", "slot").unwrap(), "poster");
        assert_eq!(
            mcp_post(&app, path, payload).await.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(count(&db, table).await, 1);
    }
    assert_eq!(count(&db, "media_asset").await, 2);
    std::fs::remove_dir_all(root).unwrap();
}
// Catches consuming tokens before validation and accepting expired/wrong-principal tokens.
#[tokio::test]
async fn mcp_invalid_complete_drafts_leave_no_content_and_preserve_tokens() {
    let (db, app, root) = setup().await;
    let (valid, _) = complete_draft(&db, &app).await;
    for path in ["/api/admin/movies", "/api/admin/series"] {
        for (field, expected) in [
            ("synopsis", "synopsis"),
            ("year", "year"),
            ("genre_ids", "genres"),
            ("staged_poster_token", "poster"),
        ] {
            let mut invalid = valid.clone();
            invalid.as_object_mut().unwrap().remove(field);
            let response = mcp_post(&app, path, invalid).await;
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "missing {field}: {path}"
            );
            assert_eq!(
                body(response).await["fields"],
                serde_json::json!([expected])
            );
        }
        let mut cases = vec![
            ("name", serde_json::json!("  "), "name"),
            ("synopsis", serde_json::json!("  "), "synopsis"),
            ("year", serde_json::json!(0), "year"),
            ("year", serde_json::json!(-1), "year"),
            ("year", serde_json::json!(10000), "year"),
            ("genre_ids", serde_json::json!([]), "genres"),
            (
                "genre_ids",
                serde_json::json!([uuid::Uuid::new_v4()]),
                "genres",
            ),
            ("genre_ids", serde_json::json!(["bad-id"]), "genres"),
            (
                "genre_ids",
                serde_json::json!([valid["genre_ids"][0], valid["genre_ids"][0]]),
                "genres",
            ),
            (
                "staged_poster_token",
                serde_json::json!("invalid-token"),
                "poster",
            ),
        ];
        if path.ends_with("movies") {
            for value in [
                serde_json::json!(null),
                serde_json::json!(0),
                serde_json::json!(-1),
            ] {
                cases.push(("duration_seconds", value, "duration_seconds"));
            }
        }
        for (field, value, expected) in cases {
            let mut invalid = valid.clone();
            invalid[field] = value;
            let response = mcp_post(&app, path, invalid).await;
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid {field}: {path}"
            );
            assert_eq!(
                body(response).await["fields"],
                serde_json::json!([expected])
            );
        }
        for (sql, expected) in [
            ("UPDATE genre SET enabled=false", "genres"),
            (
                "UPDATE mcp_staged_poster SET principal_hash='another-principal'",
                "poster",
            ),
            (
                "UPDATE mcp_staged_poster SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'",
                "poster",
            ),
        ] {
            db.execute_unprepared(sql).await.unwrap();
            let response = mcp_post(&app, path, valid.clone()).await;
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{sql}: {path}"
            );
            assert_eq!(
                body(response).await["fields"],
                serde_json::json!([expected])
            );
            db.execute_unprepared("UPDATE genre SET enabled=true")
                .await
                .unwrap();
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE mcp_staged_poster SET principal_hash=$1,expires_at=CURRENT_TIMESTAMP+INTERVAL '30 minutes'",
                [csrf::digest(KEY).into()],
            )).await.unwrap();
        }
        for table in [
            "movie",
            "series",
            "movie_genre",
            "series_genre",
            "media_asset_ownership",
        ] {
            assert_eq!(count(&db, table).await, 0);
        }
        assert_eq!(count(&db, "mcp_staged_poster").await, 1);
        assert_eq!(count(&db, "media_asset").await, 1);
    }
    std::fs::remove_dir_all(root).unwrap();
}
// Deferred constraint failure occurs at COMMIT after every application write has succeeded.
#[tokio::test]
async fn mcp_failed_commit_restores_token_and_all_content_writes() {
    let (db, app, root) = setup().await;
    for (path, table) in [
        ("/api/admin/movies", "movie"),
        ("/api/admin/series", "series"),
    ] {
        let (payload, asset) = complete_draft(&db, &app).await;
        let owners = count(&db, "media_asset_ownership").await;
        db.execute_unprepared("CREATE OR REPLACE FUNCTION reject_draft_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$").await.unwrap();
        db.execute_unprepared(&format!("CREATE CONSTRAINT TRIGGER reject_draft_commit AFTER INSERT ON {table}_genre DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_draft_commit()")).await.unwrap();
        assert_eq!(
            mcp_post(&app, path, payload.clone()).await.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(count(&db, table).await, 0);
        assert_eq!(count(&db, &format!("{table}_genre")).await, 0);
        assert_eq!(count(&db, "mcp_staged_poster").await, 1);
        assert_eq!(count(&db, "media_asset_ownership").await, owners);
        db.execute_unprepared(&format!(
            "DROP TRIGGER reject_draft_commit ON {table}_genre"
        ))
        .await
        .unwrap();
        let response = mcp_post(&app, path, payload).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(body(response).await["poster"]["id"], asset);
        assert_eq!(count(&db, "mcp_staged_poster").await, 0);
    }
    std::fs::remove_dir_all(root).unwrap();
}
// Competing movie/series requests must not share a staged asset across content kinds.
#[tokio::test]
async fn mcp_concurrent_movie_and_series_consume_poster_once() {
    let (db, app, root) = setup().await;
    let (payload, asset) = complete_draft(&db, &app).await;
    let (movie, series) = tokio::join!(
        mcp_post(&app, "/api/admin/movies", payload.clone()),
        mcp_post(&app, "/api/admin/series", payload)
    );
    let statuses = [movie.status(), series.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|&&s| s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|&&s| s == StatusCode::UNPROCESSABLE_ENTITY)
            .count(),
        1
    );
    let winner = if movie.status() == StatusCode::CREATED {
        movie
    } else {
        series
    };
    assert_eq!(body(winner).await["poster"]["id"], asset);
    assert_eq!(count(&db, "movie").await + count(&db, "series").await, 1);
    assert_eq!(
        count(&db, "movie_genre").await + count(&db, "series_genre").await,
        1
    );
    assert_eq!(count(&db, "mcp_staged_poster").await, 0);
    assert_eq!(count(&db, "media_asset_ownership").await, 1);
    assert_eq!(count(&db, "media_asset").await, 1);
    std::fs::remove_dir_all(root).unwrap();
}

// Catches missing MCP duration enforcement and incorrect parent/child version updates.
#[tokio::test]
async fn mcp_episode_duration_is_required_and_versions_remain_atomic() {
    let (db, app, root) = setup().await;
    let series = uuid::Uuid::new_v4();
    let season = uuid::Uuid::new_v4();
    db.execute_unprepared(&format!("INSERT INTO series(id,name,is_private,status,version) VALUES ('{series}','Parent',true,'draft',1); INSERT INTO season(id,series_id,number) VALUES ('{season}','{series}',1)")).await.unwrap();
    let path = format!("/api/admin/series/{series}/seasons/{season}/episodes");
    for duration in [
        None,
        Some(serde_json::json!(null)),
        Some(serde_json::json!(0)),
        Some(serde_json::json!(-1)),
    ] {
        let mut input = serde_json::json!({"version":1,"number":1,"name":"Episode"});
        if let Some(value) = duration {
            input["duration_seconds"] = value;
        }
        let response = mcp_post(&app, &path, input).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body(response).await["fields"],
            serde_json::json!(["duration_seconds"])
        );
        assert_eq!(count(&db, "episode").await, 0);
    }
    let payload =
        serde_json::json!({"version":1,"number":1,"name":"Episode","duration_seconds":1800});
    let (first, second) = tokio::join!(
        mcp_post(&app, &path, payload.clone()),
        mcp_post(&app, &path, payload)
    );
    let statuses = [first.status(), second.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|&&s| s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|&&s| s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let result = body(if first.status() == StatusCode::CREATED {
        first
    } else {
        second
    })
    .await;
    assert_eq!(result["version"], 2);
    assert_eq!(
        result["seasons"][0]["episodes"][0]["duration_seconds"],
        1800
    );
    assert_eq!(result["seasons"][0]["episodes"][0]["version"], 1);
    assert_eq!(result["seasons"][0]["episodes"][0]["status"], "draft");
    let duplicate = mcp_post(
        &app,
        &path,
        serde_json::json!({"version":2,"number":1,"name":"Duplicate","duration_seconds":1800}),
    )
    .await;
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert_eq!(count(&db, "episode").await, 1);
    let version: i64 = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT version FROM series WHERE id=$1",
            [series.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "version")
        .unwrap();
    assert_eq!(version, 2);
    std::fs::remove_dir_all(root).unwrap();
}

// Catches falling through to administrator 400 errors or reporting only the first invalid field.
#[tokio::test]
async fn mcp_episode_semantic_errors_report_all_fields_without_writes() {
    let (db, app, root) = setup().await;
    let series = uuid::Uuid::new_v4();
    let season = uuid::Uuid::new_v4();
    db.execute_unprepared(&format!("INSERT INTO series(id,name,is_private,status,version) VALUES ('{series}','Parent',true,'draft',1); INSERT INTO season(id,series_id,number) VALUES ('{season}','{series}',1)")).await.unwrap();
    let path = format!("/api/admin/series/{series}/seasons/{season}/episodes");
    let valid =
        serde_json::json!({"version":1,"number":1,"name":"Episode","duration_seconds":1800});
    let mut cases = Vec::new();
    for (field, value) in [
        ("version", serde_json::json!(0)),
        ("version", serde_json::json!(-1)),
        ("number", serde_json::json!(0)),
        ("number", serde_json::json!(-1)),
        ("name", serde_json::json!(" \t\n ")),
    ] {
        let mut input = valid.clone();
        input[field] = value;
        cases.push((input, serde_json::json!([field])));
    }
    cases.push((
        serde_json::json!({"version":0,"number":-1,"name":" "}),
        serde_json::json!(["version", "number", "name", "duration_seconds"]),
    ));
    cases.push((
        serde_json::json!({"version":-1,"number":0,"name":" ","duration_seconds":0}),
        serde_json::json!(["version", "number", "name", "duration_seconds"]),
    ));
    cases.push((
        serde_json::json!({"version":1,"number":0,"name":" ","duration_seconds":1800}),
        serde_json::json!(["number", "name"]),
    ));
    let mut actual = Vec::new();
    let mut expected = Vec::new();
    for (input, fields) in cases {
        let response = mcp_post(&app, &path, input).await;
        let status = response.status();
        actual.push((status, body(response).await["fields"].clone()));
        expected.push((StatusCode::UNPROCESSABLE_ENTITY, fields));
        assert_eq!(count(&db, "episode").await, 0);
        let version: i64 = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT version FROM series WHERE id=$1",
                [series.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "version")
            .unwrap();
        assert_eq!(version, 1);
    }
    assert_eq!(actual, expected);
    std::fs::remove_dir_all(root).unwrap();
}
