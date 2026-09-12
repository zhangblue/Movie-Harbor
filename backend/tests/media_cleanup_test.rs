use axum::body::Bytes;
use movie_harbor_api::{
    app,
    config::Config,
    entities::{file_cleanup_job, media_asset, movie},
    media::{
        AttachmentTarget, ChunkSource, LocalMediaStorage, MediaError, StorageEvent, StorageHooks,
        UploadPolicy, cleanup::run_once, replace_attachment,
    },
    movies::service as movie_service,
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseBackend,
    DatabaseConnection, EntityTrait, IntoActiveModel, Set, Statement, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
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
    failures: AtomicUsize,
    sync_attempts: AtomicUsize,
}

struct ReplaceRegisteredAtUnlink {
    root: PathBuf,
    replaced: AtomicBool,
    no_quarantine_data_before_claim: AtomicBool,
}

struct PromotionHooks(AtomicBool);

impl StorageHooks for PromotionHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::Promoted(_)) {
            self.0.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

struct PausedSource {
    entered: Arc<Notify>,
    release: Arc<Notify>,
    done: bool,
}

impl ChunkSource for PausedSource {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            if self.done {
                return Ok(None);
            }
            self.done = true;
            self.entered.notify_one();
            self.release.notified().await;
            Ok(Some(Bytes::from_static(&[
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
                1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100,
                248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
                130,
            ])))
        })
    }
}

impl StorageHooks for ReplaceRegisteredAtUnlink {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        let StorageEvent::BeforeUnlink(key) = event else {
            return Ok(());
        };
        if self.replaced.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.no_quarantine_data_before_claim.store(
            std::fs::read_dir(self.root.join(".quarantine"))?.all(|entry| {
                entry
                    .map(|entry| entry.path().extension() != Some(std::ffi::OsStr::new("data")))
                    .unwrap_or(false)
            }),
            Ordering::SeqCst,
        );
        let formal = self.root.join(key);
        std::fs::rename(&formal, formal.with_extension("owned-original"))?;
        std::fs::write(formal, b"UNRELATED REPLACEMENT")
    }
}

impl StorageHooks for FailFirstPostUnlinkSync {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::BeforeDirectorySync(_)) {
            self.sync_attempts.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }

    fn fail_next_post_unlink_sync(&self) -> bool {
        self.failures.fetch_add(1, Ordering::SeqCst) == 0
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
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn queued(
    db: &DatabaseConnection,
    key: &str,
    contents: &[u8],
) -> (media_asset::Model, file_cleanup_job::Model) {
    let asset = media_asset::ActiveModel {
        id: Set(Uuid::new_v4()),
        storage_key: Set(key.into()),
        original_name: Set("old.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(i64::try_from(contents.len()).unwrap()),
        purpose: Set("poster".into()),
        checksum_sha256: Set(Some(format!("{:x}", Sha256::digest(contents)))),
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

async fn named_connection(schema: &str, application_name: &str) -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let mut options = ConnectOptions::new(format!("{url}?application_name={application_name}"));
    options.set_schema_search_path(schema.to_owned());
    Database::connect(options).await.unwrap()
}

async fn wait_for_cleanup_to_reach_storage_lock(
    admin: &DatabaseConnection,
    application_name: &str,
) {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut stable_pre_transaction_polls = 0;
        loop {
            let row = admin
                .query_one(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!(
                        "SELECT COALESCE(bool_or(state='idle in transaction' AND query ILIKE '%episode%'), false) AS locked_asset, count(*) FILTER (WHERE state='idle' AND query ILIKE '%file_cleanup_job%')::bigint AS before_transaction FROM pg_stat_activity WHERE application_name='{application_name}'"
                    ),
                ))
                .await
                .unwrap()
                .unwrap();
            if row.try_get::<bool>("", "locked_asset").unwrap() {
                break;
            }
            if row.try_get::<i64>("", "before_transaction").unwrap() > 0 {
                stable_pre_transaction_polls += 1;
                if stable_pre_transaction_polls == 5 {
                    break;
                }
            } else {
                stable_pre_transaction_polls = 0;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_lock_or_completion(
    admin: &DatabaseConnection,
    application_name: &str,
    task: &tokio::task::JoinHandle<
        Result<movie_harbor_api::movies::dto::MovieResponse, movie_service::MovieError>,
    >,
) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if task.is_finished() {
                break;
            }
            let waiting = admin
                .query_one(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!(
                        "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE application_name='{application_name}' AND wait_event_type='Lock'"
                    ),
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "count")
                .unwrap();
            if waiting > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
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
    let (asset, _) = queued(&db, &key, b"x").await;

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
    queued(&db, &key, b"x").await;

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

// Catches cleanup hashing one inode and unlinking a later filename replacement.
#[tokio::test]
async fn registered_cleanup_claim_never_deletes_a_replacement_swapped_before_unlink() {
    let db = database().await;
    let root = TempRoot::new();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, b"x").unwrap();
    let hooks = Arc::new(ReplaceRegisteredAtUnlink {
        root: root.as_ref().to_owned(),
        replaced: AtomicBool::new(false),
        no_quarantine_data_before_claim: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (_, job) = queued(&db, &key, b"x").await;

    let outcome = run_once(&db, &storage).await.unwrap();

    assert_eq!((outcome.succeeded, outcome.failed), (0, 1));
    assert!(hooks.no_quarantine_data_before_claim.load(Ordering::SeqCst));
    assert_eq!(std::fs::read(&formal).unwrap(), b"UNRELATED REPLACEMENT");
    assert!(formal.with_extension("owned-original").exists());
    assert!(
        file_cleanup_job::Entity::find_by_id(job.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
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
        failures: AtomicUsize::new(0),
        sync_attempts: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (_, job) = queued(&db, &key, b"x").await;

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
    assert_eq!(hooks.sync_attempts.load(Ordering::SeqCst), 1);
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
    let (asset, job) = queued(&db, &key, b"outside").await;

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
    let (_, job) = queued(&db, &key, b"inside").await;

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

// Catches cleanup holding a media row while waiting for the storage mutation mutex, completing a
// storage -> content -> media -> storage cycle with upload and reassociation.
#[tokio::test]
async fn global_storage_content_media_lock_order_prevents_three_party_deadlock() {
    let db = database().await;
    let schema = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT current_schema() AS schema".to_owned(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "schema")
        .unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let associate_name = format!("lock_order_associate_{suffix}");
    let upload_name = format!("lock_order_upload_{suffix}");
    let cleanup_name = format!("lock_order_cleanup_{suffix}");
    let associate_db = named_connection(&schema, &associate_name).await;
    let upload_db = named_connection(&schema, &upload_name).await;
    let cleanup_db = named_connection(&schema, &cleanup_name).await;
    let movie = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Lock order".into()),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let movie_id = movie.id;
    let root = TempRoot::new();
    let hooks = Arc::new(PromotionHooks(AtomicBool::new(false)));
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let asset_id = Uuid::new_v4();
    let simple = asset_id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    std::fs::create_dir_all(root.as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(root.as_ref().join(&key), b"x").unwrap();
    let (asset, job) = queued(&db, &key, b"x").await;

    let movie_guard = db.begin().await.unwrap();
    movie_guard
        .execute_unprepared(&format!(
            "SELECT id FROM movie WHERE id='{}' FOR UPDATE",
            movie_id
        ))
        .await
        .unwrap();
    let associate = tokio::spawn(async move {
        movie_service::associate_media(
            &associate_db,
            movie_id,
            asset.id,
            1,
            movie_service::MediaSlot::Poster,
        )
        .await
    });
    wait_for_lock_or_completion(&db, &associate_name, &associate).await;

    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let source_entered = entered.clone();
    let source_release = release.clone();
    let upload_storage = storage.clone();
    let upload = tokio::spawn(async move {
        replace_attachment(
            &upload_db,
            &upload_storage,
            AttachmentTarget::MoviePoster {
                id: movie_id,
                version: 1,
            },
            "replacement.png",
            "image/png",
            &UploadPolicy::new(1024, ["video/mp4"]).unwrap(),
            PausedSource {
                entered: source_entered,
                release: source_release,
                done: false,
            },
        )
        .await
    });
    entered.notified().await;
    let cleanup_storage = storage.clone();
    let cleanup = tokio::spawn(async move { run_once(&cleanup_db, &cleanup_storage).await });
    wait_for_cleanup_to_reach_storage_lock(&db, &cleanup_name).await;

    movie_guard.commit().await.unwrap();
    wait_for_lock_or_completion(&db, &associate_name, &associate).await;
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(8), async {
        while !hooks.0.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let (associate, upload, cleanup) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(associate, upload, cleanup)
    })
    .await
    .expect("global media operations exceeded the bounded lock-order deadline");
    assert!(associate.unwrap().is_ok());
    assert!(matches!(upload.unwrap(), Err(MediaError::VersionConflict)));
    let cleanup = cleanup.unwrap().unwrap();
    assert_eq!((cleanup.succeeded, cleanup.failed), (0, 1));
    let retry = file_cleanup_job::Entity::find_by_id(job.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry.attempts, 1);
    assert!(root.as_ref().join(&key).exists());
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
    let (_, job) = queued(&db, &key, b"x").await;
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
