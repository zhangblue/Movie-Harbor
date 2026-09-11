use movie_harbor_api::{
    app,
    config::Config,
    entities::{file_cleanup_job, media_asset},
    media::{LocalMediaStorage, StorageEvent, StorageHooks, cleanup::run_once},
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    IntoActiveModel, Set,
};
use sea_orm_migration::MigratorTrait;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
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

struct UnlinkRaceHooks {
    root: PathBuf,
    outside: PathBuf,
    fired: AtomicBool,
}

#[derive(Default)]
struct RecordingHooks(Mutex<Vec<StorageEvent>>);

impl StorageHooks for RecordingHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct FailFirstPostUnlinkSync {
    unlinked: AtomicBool,
    failures: AtomicUsize,
    sync_attempts: AtomicUsize,
}

impl StorageHooks for FailFirstPostUnlinkSync {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::Unlinked(_)) {
            self.unlinked.store(true, Ordering::SeqCst);
        }
        if matches!(event, StorageEvent::BeforeDirectorySync(_))
            && self.unlinked.load(Ordering::SeqCst)
        {
            self.sync_attempts.fetch_add(1, Ordering::SeqCst);
            if self.failures.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(std::io::Error::other("injected directory fsync failure"));
            }
        }
        Ok(())
    }
}

impl StorageHooks for UnlinkRaceHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if !matches!(event, StorageEvent::BeforeUnlink(_))
            || self.fired.swap(true, Ordering::SeqCst)
        {
            return Ok(());
        }
        let StorageEvent::BeforeUnlink(key) = event else {
            unreachable!()
        };
        let target = self.root.join(key);
        let parent = target.parent().unwrap();
        let moved = parent.with_extension("moved");
        std::fs::rename(parent, moved)?;
        std::os::unix::fs::symlink(&self.outside, parent)?;
        std::fs::write(self.outside.join(target.file_name().unwrap()), b"outside")
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

// Catches acknowledging a cleanup before the unlink's directory entry is durable.
#[tokio::test]
async fn successful_cleanup_syncs_the_containing_directory_after_unlink() {
    let db = database().await;
    let root = TempRoot::new();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"x").unwrap();
    let hooks = Arc::new(RecordingHooks::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    queued(&db, &key).await;

    assert_eq!(run_once(&db, &storage).await.unwrap().succeeded, 1);
    let events = hooks.0.lock().unwrap();
    let unlinked = events
        .iter()
        .position(|event| event == &StorageEvent::Unlinked(key.clone()))
        .unwrap();
    assert!(
        events[unlinked + 1..].contains(&StorageEvent::DirectorySynced(format!(
            "poster/{}",
            &simple[..2]
        )))
    );
}

// Catches an ENOENT retry deleting the job without retrying an uncertain directory fsync.
#[tokio::test]
async fn retry_after_unlink_fsync_failure_syncs_missing_file_directory_before_success() {
    let db = database().await;
    let root = TempRoot::new();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"x").unwrap();
    let hooks = Arc::new(FailFirstPostUnlinkSync {
        unlinked: AtomicBool::new(false),
        failures: AtomicUsize::new(0),
        sync_attempts: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (_, job) = queued(&db, &key).await;

    let first = run_once(&db, &storage).await.unwrap();
    assert_eq!((first.succeeded, first.failed), (0, 1));
    assert!(!root.as_ref().join(&key).exists());
    let mut retry = file_cleanup_job::Entity::find_by_id(job.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    retry.next_attempt_at = Set((chrono::Utc::now() - chrono::Duration::minutes(1)).fixed_offset());
    retry.update(&db).await.unwrap();

    let second = run_once(&db, &storage).await.unwrap();
    assert_eq!((second.succeeded, second.failed), (1, 0));
    assert!(
        file_cleanup_job::Entity::find_by_id(job.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(hooks.sync_attempts.load(Ordering::SeqCst), 2);
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

// Catches path-based cleanup unlinking an external file after a parent-directory swap.
#[cfg(unix)]
#[tokio::test]
async fn cleanup_unlink_stays_bound_to_the_opened_internal_directory() {
    let db = database().await;
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"inside").unwrap();
    let hooks = Arc::new(UnlinkRaceHooks {
        root: root.as_ref().to_owned(),
        outside: outside.as_ref().to_owned(),
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let (_, job) = queued(&db, &key).await;

    let outcome = run_once(&db, &storage).await.unwrap();
    assert_eq!((outcome.succeeded, outcome.failed), (1, 0));
    assert_eq!(
        std::fs::read(outside.as_ref().join(format!("{}.png", id.simple()))).unwrap(),
        b"outside"
    );
    assert!(
        file_cleanup_job::Entity::find_by_id(job.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
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
    let stale_part = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::create_dir_all(stale_part.parent().unwrap()).unwrap();
    std::fs::write(&stale_part, b"stale").unwrap();
    std::fs::File::open(&stale_part)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(7200)),
        )
        .unwrap();

    let _app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    assert!(!stale_part.exists());
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
