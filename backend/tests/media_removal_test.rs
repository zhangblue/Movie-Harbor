use movie_harbor_api::media::{
    LocalMediaStorage, MediaError, StorageEvent, StorageHooks,
    removal::{self, OwnedMedia},
};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

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
