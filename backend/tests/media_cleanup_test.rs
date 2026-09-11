use movie_harbor_api::{
    app,
    config::Config,
    entities::{file_cleanup_job, media_asset},
    media::{LocalMediaStorage, cleanup::run_once},
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    Set,
};
use sea_orm_migration::MigratorTrait;
use std::path::{Path, PathBuf};
use uuid::Uuid;

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_cleanup_{}", Uuid::new_v4()));
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

async fn database() -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("media_cleanup_test_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut options = ConnectOptions::new(url);
    options.set_schema_search_path(schema);
    let db = Database::connect(options).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
    db
}

fn config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn queued(
    db: &DatabaseConnection,
    key: &str,
) -> (media_asset::Model, file_cleanup_job::Model) {
    let asset = media_asset::ActiveModel {
        id: Set(Uuid::new_v4()),
        storage_key: Set(key.into()),
        original_name: Set("old.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(1),
        purpose: Set("poster".into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let job = file_cleanup_job::ActiveModel {
        id: Set(Uuid::new_v4()),
        media_asset_id: Set(asset.id),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    (asset, job)
}

// Catches removing a file but retaining its task/asset records, or vice versa.
#[tokio::test]
async fn successful_cleanup_removes_the_registered_file_job_and_asset() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let id = Uuid::new_v4();
    let key = format!(
        "poster/{}/{}.png",
        &id.simple().to_string()[..2],
        id.simple()
    );
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"x").unwrap();
    let unregistered_id = Uuid::new_v4();
    let unregistered_key = format!(
        "poster/{}/{}.png",
        &unregistered_id.simple().to_string()[..2],
        unregistered_id.simple()
    );
    std::fs::create_dir_all(root.as_ref().join(&unregistered_key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&unregistered_key), b"unregistered").unwrap();
    let (asset, _) = queued(&db, &key).await;

    let outcome = run_once(&db, &storage).await.unwrap();
    assert_eq!((outcome.succeeded, outcome.failed), (1, 0));
    assert!(!root.as_ref().join(key).exists());
    assert!(root.as_ref().join(unregistered_key).exists());
    assert!(
        media_asset::Entity::find_by_id(asset.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        file_cleanup_job::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .len(),
        0
    );
}

// Catches traversal/symlink escapes, unbounded error persistence, and non-retrying jobs.
#[cfg(unix)]
#[tokio::test]
async fn cleanup_rejects_symlink_escape_and_records_a_sanitized_retry() {
    let db = database().await;
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let id = Uuid::new_v4();
    let key = format!("poster/aa/{}.png", id.simple());
    std::fs::create_dir_all(root.as_ref().join("poster")).unwrap();
    std::os::unix::fs::symlink(outside.as_ref(), root.as_ref().join("poster/aa")).unwrap();
    std::fs::write(
        outside.as_ref().join(format!("{}.png", id.simple())),
        b"outside",
    )
    .unwrap();
    let (asset, job) = queued(&db, &key).await;

    let outcome = run_once(&db, &storage).await.unwrap();
    assert_eq!((outcome.succeeded, outcome.failed), (0, 1));
    assert!(
        outside
            .as_ref()
            .join(format!("{}.png", id.simple()))
            .exists()
    );
    assert!(
        media_asset::Entity::find_by_id(asset.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    let retried = file_cleanup_job::Entity::find_by_id(job.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retried.attempts, 1);
    let error = retried.last_error.unwrap();
    assert!(error.len() <= 256);
    assert!(!error.chars().any(char::is_control));
}

// Catches failing to register the cleanup worker during application construction.
#[tokio::test]
async fn application_starts_the_due_cleanup_worker() {
    let db = database().await;
    let root = TempRoot::new();
    let id = Uuid::new_v4();
    let key = format!(
        "poster/{}/{}.png",
        &id.simple().to_string()[..2],
        id.simple()
    );
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"x").unwrap();
    let (_, job) = queued(&db, &key).await;

    let _app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    for _ in 0..100 {
        if file_cleanup_job::Entity::find_by_id(job.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
        {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("cleanup worker did not process the due registered job");
}
