use movie_harbor_api::entities::{media_asset, movie};
use movie_harbor_api::media::{
    LocalMediaStorage, MediaError, StorageEvent, StorageHooks,
    removal::{self, OwnedMedia},
};
use sea_orm::{ActiveModelTrait, EntityTrait, Set, TransactionTrait};
use serde_json::json;
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

mod support;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_removal_{}", Uuid::new_v4()));
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

async fn storage_fixture() -> (LocalMediaStorage, TempRoot) {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    (storage, root)
}

async fn registered_file(root: &Path, storage_key: &str, bytes: &[u8]) -> OwnedMedia {
    let path = root.join(storage_key);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&path, bytes).await.unwrap();
    OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_key: storage_key.to_owned(),
    }
}

async fn registered_asset(
    db: &sea_orm::DatabaseConnection,
    storage_key: &str,
) -> media_asset::Model {
    media_asset::ActiveModel {
        id: Set(Uuid::new_v4()),
        storage_key: Set(storage_key.to_owned()),
        original_name: Set("asset.bin".into()),
        mime_type: Set("application/octet-stream".into()),
        byte_size: Set(1),
        purpose: Set("video".into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn operation_directories(root: &Path) -> Vec<PathBuf> {
    let mut reader = tokio::fs::read_dir(root.join(".operations")).await.unwrap();
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await.unwrap() {
        if entry.file_type().await.unwrap().is_dir() {
            entries.push(entry.path());
        }
    }
    entries
}

#[tokio::test]
async fn common_delete_helpers_load_and_delete_media_assets() {
    let database = support::TestDatabase::migrated("removal_common_database_helpers").await;
    let db = database.connection();
    let first = registered_asset(&db, "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4").await;
    let second = registered_asset(&db, "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4").await;

    let loaded = removal::load_owned_media(&db, &[first.id, second.id])
        .await
        .unwrap();
    assert_eq!(loaded.len(), 2);
    assert!(
        loaded
            .iter()
            .any(|item| item.storage_key == first.storage_key)
    );

    removal::delete_media_assets(&db, &[first.id, second.id])
        .await
        .unwrap();
    assert!(
        media_asset::Entity::find_by_id(first.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        media_asset::Entity::find_by_id(second.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn common_delete_helpers_roll_back_and_restore_when_database_operation_fails() {
    let database = support::TestDatabase::migrated("removal_common_operation_failure").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let file = registered_file(
        root.as_ref(),
        "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        b"video",
    )
    .await;
    let staged = removal::stage(&storage, "delete-movie", std::slice::from_ref(&file))
        .await
        .unwrap();
    let inserted_id = Uuid::new_v4();
    let tx = db.begin().await.unwrap();
    media_asset::ActiveModel {
        id: Set(inserted_id),
        storage_key: Set("video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4".into()),
        original_name: Set("rolled-back.mp4".into()),
        mime_type: Set("video/mp4".into()),
        byte_size: Set(1),
        purpose: Set("video".into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(&tx)
    .await
    .unwrap();

    let result = removal::finish_delete_transaction(
        tx,
        staged,
        1,
        Err::<(), _>("injected database failure"),
    )
    .await;
    assert!(matches!(
        result,
        Err(removal::FinishDeleteError::Operation(
            "injected database failure"
        ))
    ));
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&file.storage_key))
            .await
            .unwrap(),
        b"video"
    );
    assert!(
        media_asset::Entity::find_by_id(inserted_id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn common_delete_helpers_commit_and_return_deleted_media_count() {
    let database = support::TestDatabase::migrated("removal_common_commit").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let file = registered_file(
        root.as_ref(),
        "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        b"video",
    )
    .await;
    let staged = removal::stage(&storage, "delete-movie", std::slice::from_ref(&file))
        .await
        .unwrap();

    let deleted =
        removal::finish_delete_transaction::<()>(db.begin().await.unwrap(), staged, 3, Ok(()))
            .await
            .unwrap();
    assert_eq!(deleted, 3);
    assert!(!root.as_ref().join(&file.storage_key).exists());
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

#[cfg(unix)]
struct MakeOperationReadOnlyAfterStage {
    root: PathBuf,
}

#[cfg(unix)]
impl StorageHooks for MakeOperationReadOnlyAfterStage {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::AfterStageRename(_)) {
            use std::os::unix::fs::PermissionsExt;

            let operation = std::fs::read_dir(self.root.join(".operations"))?
                .next()
                .expect("the removal operation exists")?
                .path();
            std::fs::set_permissions(operation, std::fs::Permissions::from_mode(0o500))?;
        }
        Ok(())
    }
}

#[cfg(unix)]
#[tokio::test]
async fn common_delete_helpers_classify_post_commit_cleanup_failure_as_finalize() {
    use std::os::unix::fs::PermissionsExt;

    let database = support::TestDatabase::migrated("removal_common_finalize").await;
    let db = database.connection();
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(MakeOperationReadOnlyAfterStage {
            root: root.as_ref().to_owned(),
        }),
    )
    .await
    .unwrap();
    let file = registered_file(
        root.as_ref(),
        "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        b"video",
    )
    .await;
    let staged = removal::stage(&storage, "delete-movie", std::slice::from_ref(&file))
        .await
        .unwrap();

    let result =
        removal::finish_delete_transaction::<()>(db.begin().await.unwrap(), staged, 1, Ok(()))
            .await;
    assert!(matches!(result, Err(removal::FinishDeleteError::Finalize)));
    let operation = operation_directories(root.as_ref())
        .await
        .into_iter()
        .next()
        .expect("the failed operation remains");
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_file());
    std::fs::set_permissions(operation, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[tokio::test]
async fn staged_removal_can_restore_or_finish_owned_files() {
    let (storage, root) = storage_fixture().await;
    let asset = registered_file(
        root.as_ref(),
        "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        b"video",
    )
    .await;

    let staged = removal::stage(&storage, "delete-movie", std::slice::from_ref(&asset))
        .await
        .unwrap();
    assert!(!root.as_ref().join(&asset.storage_key).exists());
    staged.restore().await.unwrap();
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&asset.storage_key))
            .await
            .unwrap(),
        b"video"
    );

    let staged = removal::stage(&storage, "delete-movie", &[asset])
        .await
        .unwrap();
    staged.finish().await.unwrap();
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

struct FailSecondMove {
    root: PathBuf,
    moves: AtomicUsize,
    saw_manifest: AtomicBool,
}

struct FailPostRenameSync {
    failed: AtomicBool,
}

impl StorageHooks for FailPostRenameSync {
    fn fail_next_post_stage_sync(&self) -> bool {
        !self.failed.swap(true, Ordering::SeqCst)
    }
}

#[tokio::test]
async fn post_rename_sync_failure_restores_the_current_file() {
    let root = TempRoot::new();
    let hooks = Arc::new(FailPostRenameSync {
        failed: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let asset = registered_file(
        root.as_ref(),
        "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        b"original-video",
    )
    .await;

    assert!(matches!(
        removal::stage(&storage, "delete-episode", std::slice::from_ref(&asset)).await,
        Err(MediaError::Io(_))
    ));
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&asset.storage_key))
            .await
            .unwrap(),
        b"original-video"
    );
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

struct LeaveResidualStagedData {
    root: PathBuf,
    failed: AtomicBool,
}

impl StorageHooks for LeaveResidualStagedData {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::AfterStageRename(_)) {
            let operation = std::fs::read_dir(self.root.join(".operations"))?
                .next()
                .expect("the removal operation exists")?
                .path();
            std::fs::write(operation.join("untracked.data"), b"residual")?;
        }
        Ok(())
    }

    fn fail_next_post_stage_sync(&self) -> bool {
        !self.failed.swap(true, Ordering::SeqCst)
    }
}

#[tokio::test]
async fn close_with_residual_staged_data_preserves_the_manifest() {
    let root = TempRoot::new();
    let storage_key = "video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4";
    let hooks = Arc::new(LeaveResidualStagedData {
        root: root.as_ref().to_owned(),
        failed: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let asset = registered_file(root.as_ref(), storage_key, b"original-video").await;

    assert!(matches!(
        removal::stage(&storage, "delete-episode", &[asset]).await,
        Err(MediaError::Io(_))
    ));
    let operations = operation_directories(root.as_ref()).await;
    assert_eq!(operations.len(), 1);
    assert_eq!(
        tokio::fs::read(root.as_ref().join(storage_key))
            .await
            .unwrap(),
        b"original-video"
    );
    assert!(!operations[0].join("00000000.data").exists());
    assert_eq!(
        tokio::fs::read(operations[0].join("untracked.data"))
            .await
            .unwrap(),
        b"residual"
    );
    assert!(operations[0].join("manifest.json").is_file());
}

impl StorageHooks for FailSecondMove {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if let StorageEvent::BeforeStage(_) = event {
            let entries = std::fs::read_dir(self.root.join(".operations"))?;
            self.saw_manifest.store(
                entries
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().join("manifest.json").is_file()),
                Ordering::SeqCst,
            );
            if self.moves.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(io::Error::other("injected second move failure"));
            }
        }
        Ok(())
    }
}

#[tokio::test]
async fn second_move_failure_restores_the_first_file_and_removes_the_operation() {
    let root = TempRoot::new();
    let hooks = Arc::new(FailSecondMove {
        root: root.as_ref().to_owned(),
        moves: AtomicUsize::new(0),
        saw_manifest: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let first = registered_file(
        root.as_ref(),
        "poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        b"first",
    )
    .await;
    let second = registered_file(
        root.as_ref(),
        "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4",
        b"second",
    )
    .await;

    assert!(matches!(
        removal::stage(&storage, "delete-series", &[first.clone(), second.clone()]).await,
        Err(MediaError::Io(_))
    ));
    assert!(hooks.saw_manifest.load(Ordering::SeqCst));
    assert_eq!(
        tokio::fs::read(root.as_ref().join(first.storage_key))
            .await
            .unwrap(),
        b"first"
    );
    assert_eq!(
        tokio::fs::read(root.as_ref().join(second.storage_key))
            .await
            .unwrap(),
        b"second"
    );
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

#[tokio::test]
async fn stage_rejects_invalid_and_non_regular_paths_before_moving_any_file() {
    let (storage, root) = storage_fixture().await;
    let good = registered_file(
        root.as_ref(),
        "poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        b"png",
    )
    .await;
    let escaped = OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_key: "../outside".into(),
    };
    assert!(matches!(
        removal::stage(&storage, "delete-series", &[good.clone(), escaped]).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(root.as_ref().join(&good.storage_key).exists());

    let directory_key = "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4";
    tokio::fs::create_dir_all(root.as_ref().join(directory_key))
        .await
        .unwrap();
    let directory = OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_key: directory_key.into(),
    };
    assert!(matches!(
        removal::stage(&storage, "delete-series", &[good.clone(), directory]).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(root.as_ref().join(&good.storage_key).exists());
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn stage_rejects_a_symlink_escape_before_moving_any_file() {
    let (storage, root) = storage_fixture().await;
    let good = registered_file(
        root.as_ref(),
        "poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        b"png",
    )
    .await;
    let outside = root.as_ref().with_extension("outside");
    std::fs::write(&outside, b"outside").unwrap();
    let link_key = "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4";
    tokio::fs::create_dir_all(root.as_ref().join("video/bb"))
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside, root.as_ref().join(link_key)).unwrap();
    let linked = OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_key: link_key.into(),
    };

    assert!(matches!(
        removal::stage(&storage, "delete-series", &[good.clone(), linked]).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(root.as_ref().join(&good.storage_key).exists());
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert!(operation_directories(root.as_ref()).await.is_empty());
    let _ = std::fs::remove_file(outside);
}

#[tokio::test]
async fn missing_files_are_idempotent_empty_operations() {
    let (storage, root) = storage_fixture().await;
    let missing = OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_key: "video/cc/cccccccccccccccccccccccccccccccc.mp4".into(),
    };

    removal::stage(&storage, "delete-episode", std::slice::from_ref(&missing))
        .await
        .unwrap()
        .restore()
        .await
        .unwrap();
    removal::stage(&storage, "delete-episode", std::slice::from_ref(&missing))
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    removal::stage(&storage, "delete-episode", &[missing])
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

#[tokio::test]
async fn recover_restores_referenced_files_and_finishes_unreferenced_files_idempotently() {
    let database = support::TestDatabase::migrated("removal_recover").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let referenced = registered_file(
        root.as_ref(),
        "poster/dd/dddddddddddddddddddddddddddddddd.png",
        b"referenced-poster",
    )
    .await;
    let discarded = registered_file(
        root.as_ref(),
        "video/ee/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.mp4",
        b"discarded-video",
    )
    .await;
    media_asset::ActiveModel {
        id: Set(referenced.asset_id),
        storage_key: Set(referenced.storage_key.clone()),
        original_name: Set("poster.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(17),
        purpose: Set("poster".into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Referenced movie".into()),
        poster_asset_id: Set(Some(referenced.asset_id)),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();

    drop(
        removal::stage(&storage, "replace-media", std::slice::from_ref(&referenced))
            .await
            .unwrap(),
    );
    drop(
        removal::stage(&storage, "delete-media", std::slice::from_ref(&discarded))
            .await
            .unwrap(),
    );
    assert!(!root.as_ref().join(&referenced.storage_key).exists());
    assert_eq!(operation_directories(root.as_ref()).await.len(), 2);

    removal::recover(&db, &storage).await.unwrap();
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&referenced.storage_key))
            .await
            .unwrap(),
        b"referenced-poster"
    );
    assert!(!root.as_ref().join(&discarded.storage_key).exists());
    assert!(operation_directories(root.as_ref()).await.is_empty());

    removal::recover(&db, &storage).await.unwrap();
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&referenced.storage_key))
            .await
            .unwrap(),
        b"referenced-poster"
    );
}

#[tokio::test]
async fn recover_rejects_a_manifest_storage_key_escape_without_touching_external_files() {
    let database = support::TestDatabase::migrated("removal_escape").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let operation_id = Uuid::new_v4();
    let operation = root
        .as_ref()
        .join(".operations")
        .join(operation_id.simple().to_string());
    std::fs::create_dir(&operation).unwrap();
    std::fs::write(operation.join("00000000.data"), b"quarantined").unwrap();
    std::fs::write(
        operation.join("manifest.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "operation_id": operation_id,
            "reason": "hostile-manifest",
            "entries": [{
                "asset_id": Uuid::new_v4(),
                "storage_key": "../outside.mp4",
                "staged_name": "00000000.data"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let outside = root.as_ref().with_extension("outside.mp4");
    std::fs::write(&outside, b"outside").unwrap();

    assert!(matches!(
        removal::recover(&db, &storage).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_file());
    let _ = std::fs::remove_file(outside);
}

#[tokio::test]
async fn recover_cleans_safe_manifest_publication_and_close_crash_residue() {
    let database = support::TestDatabase::migrated("removal_crash_residue").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let empty_after_mkdir = root
        .as_ref()
        .join(".operations")
        .join(Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&empty_after_mkdir).unwrap();
    let interrupted_manifest = root
        .as_ref()
        .join(".operations")
        .join(Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&interrupted_manifest).unwrap();
    std::fs::write(interrupted_manifest.join("manifest.part"), b"partial").unwrap();
    let empty_after_close = root
        .as_ref()
        .join(".operations")
        .join(Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&empty_after_close).unwrap();

    removal::recover(&db, &storage).await.unwrap();
    assert!(!empty_after_mkdir.exists());
    assert!(!interrupted_manifest.exists());
    assert!(!empty_after_close.exists());
    removal::recover(&db, &storage).await.unwrap();
}

#[tokio::test]
async fn recover_retains_manifestless_operations_that_contain_staged_evidence() {
    let database = support::TestDatabase::migrated("removal_missing_manifest").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let operation = root
        .as_ref()
        .join(".operations")
        .join(Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&operation).unwrap();
    std::fs::write(operation.join("00000000.data"), b"evidence").unwrap();

    assert!(removal::recover(&db, &storage).await.is_err());
    assert_eq!(
        std::fs::read(operation.join("00000000.data")).unwrap(),
        b"evidence"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn recover_rejects_a_referenced_staged_symlink_without_publishing_it() {
    let database = support::TestDatabase::migrated("removal_staged_symlink").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let asset_id = Uuid::new_v4();
    let storage_key = format!(
        "poster/{}/{}.png",
        &asset_id.simple().to_string()[..2],
        asset_id.simple()
    );
    media_asset::ActiveModel {
        id: Set(asset_id),
        storage_key: Set(storage_key.clone()),
        original_name: Set("poster.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(8),
        purpose: Set("poster".into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Referenced symlink".into()),
        poster_asset_id: Set(Some(asset_id)),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    std::fs::create_dir_all(root.as_ref().join(&storage_key).parent().unwrap()).unwrap();
    let operation_id = Uuid::new_v4();
    let operation = root
        .as_ref()
        .join(".operations")
        .join(operation_id.simple().to_string());
    std::fs::create_dir(&operation).unwrap();
    let outside = root.as_ref().with_extension("symlink-target");
    std::fs::write(&outside, b"external").unwrap();
    std::os::unix::fs::symlink(&outside, operation.join("00000000.data")).unwrap();
    std::fs::write(
        operation.join("manifest.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "operation_id": operation_id,
            "reason": "hostile-staged-entry",
            "entries": [{
                "asset_id": asset_id,
                "storage_key": storage_key,
                "staged_name": "00000000.data"
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(matches!(
        removal::recover(&db, &storage).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(!root.as_ref().join(&storage_key).exists());
    assert_eq!(std::fs::read(&outside).unwrap(), b"external");
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_symlink());
    let _ = std::fs::remove_file(outside);
}
