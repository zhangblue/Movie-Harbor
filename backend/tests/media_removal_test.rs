use movie_harbor_api::entities::{episode, media_asset, movie, season, series};
use movie_harbor_api::media::{
    LocalMediaStorage, MediaError, MediaStorageSet, StorageEvent, StorageHooks,
    removal::{self, OwnedMedia},
};
use movie_harbor_api::series::service::{SeriesError, delete_series};
use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, Set, TransactionTrait};
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

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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
        storage_volume: 0,
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

async fn volume_fixture() -> (MediaStorageSet, [TempRoot; 3]) {
    let roots = [TempRoot::new(), TempRoot::new(), TempRoot::new()];
    let mut paths = Vec::new();
    for (volume, root) in roots.iter().enumerate() {
        std::fs::write(
            root.as_ref().join(".movie-harbor-volume.json"),
            serde_json::to_vec(&json!({"version": 1, "volume": volume})).unwrap(),
        )
        .unwrap();
        paths.push(root.as_ref().to_owned());
    }
    (MediaStorageSet::initialize(&paths, 0).await.unwrap(), roots)
}

async fn video_files(root: &Path, storage_volume: i32, count: usize) -> Vec<OwnedMedia> {
    let mut assets = Vec::with_capacity(count);
    for _ in 0..count {
        let asset_id = Uuid::new_v4();
        let opaque = asset_id.simple().to_string();
        let key = format!("video/{}/{}.mp4", &opaque[..2], opaque);
        let mut asset = registered_file(root, &key, b"episode-video").await;
        asset.asset_id = asset_id;
        asset.storage_volume = storage_volume;
        assets.push(asset);
    }
    assets
}

// Catches writing a valid large series manifest that startup cannot read after interruption.
#[tokio::test]
async fn manifest_capacity_recovers_420_referenced_episode_files_after_interruption() {
    let database = support::TestDatabase::migrated("removal_large_manifest").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let assets = video_files(roots[1].as_ref(), 1, 420).await;
    let series_id = Uuid::new_v4();
    series::ActiveModel {
        id: Set(series_id),
        name: Set("Long series".into()),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let season_id = Uuid::new_v4();
    season::ActiveModel {
        id: Set(season_id),
        series_id: Set(series_id),
        number: Set(1),
    }
    .insert(&db)
    .await
    .unwrap();
    let tx = db.begin().await.unwrap();
    for (index, asset) in assets.iter().enumerate() {
        media_asset::ActiveModel {
            id: Set(asset.asset_id),
            storage_volume: Set(1),
            storage_key: Set(asset.storage_key.clone()),
            original_name: Set("episode.mp4".into()),
            mime_type: Set("video/mp4".into()),
            byte_size: Set(13),
            purpose: Set("video".into()),
            ..Default::default()
        }
        .insert(&tx)
        .await
        .unwrap();
        episode::ActiveModel {
            id: Set(Uuid::new_v4()),
            season_id: Set(season_id),
            number: Set(index as i32 + 1),
            name: Set(format!("Episode {}", index + 1)),
            video_asset_id: Set(Some(asset.asset_id)),
            ..Default::default()
        }
        .insert(&tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    drop(
        removal::stage(&storage, "delete-series", &assets)
            .await
            .unwrap(),
    );
    let operations = operation_directories(roots[1].as_ref()).await;
    assert_eq!(operations.len(), 1);
    let encoded = std::fs::read(operations[0].join("manifest.json")).unwrap();
    assert!(
        encoded.len() > 65_536,
        "fixture must cross the old recovery limit"
    );
    assert!(
        assets
            .iter()
            .all(|asset| !roots[1].as_ref().join(&asset.storage_key).exists())
    );
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    for asset in &assets {
        assert_eq!(
            std::fs::read(roots[1].as_ref().join(&asset.storage_key)).unwrap(),
            b"episode-video"
        );
    }
    assert_eq!(episode::Entity::find().all(&db).await.unwrap().len(), 420);
    assert_eq!(
        media_asset::Entity::find().all(&db).await.unwrap().len(),
        420
    );
    assert!(operation_directories(roots[1].as_ref()).await.is_empty());
    removal::recover(&db, &storage).await.unwrap();
}

#[derive(Default)]
struct CountManifestStageMoves(AtomicUsize);

impl StorageHooks for CountManifestStageMoves {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::BeforeStage(_)) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

// Catches entry-count rejection only during recovery, after an unreadable operation was persisted.
#[tokio::test]
async fn manifest_capacity_rejects_4097_entries_before_moving_files() {
    let root = TempRoot::new();
    let hooks = Arc::new(CountManifestStageMoves::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let assets = video_files(root.as_ref(), 0, 4097).await;
    let result = removal::stage(&storage.into(), "delete-series", &assets).await;
    assert!(
        result.is_err(),
        "an oversized entry list must be rejected during staging"
    );
    assert_eq!(
        hooks.0.load(Ordering::SeqCst),
        0,
        "capacity checks must precede every rename"
    );
    assert!(
        assets
            .iter()
            .all(|asset| root.as_ref().join(&asset.storage_key).is_file())
    );
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

// Catches unbounded encoded manifests even when their entry count remains small.
#[tokio::test]
async fn manifest_capacity_rejects_over_one_mib_before_moving_files() {
    let root = TempRoot::new();
    let hooks = Arc::new(CountManifestStageMoves::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let assets = video_files(root.as_ref(), 0, 1).await;
    let result = removal::stage(&storage.into(), &"x".repeat(1024 * 1024), &assets).await;
    assert!(
        result.is_err(),
        "encoded manifests over 1 MiB must be rejected during staging"
    );
    assert_eq!(hooks.0.load(Ordering::SeqCst), 0);
    assert!(root.as_ref().join(&assets[0].storage_key).is_file());
    assert!(operation_directories(root.as_ref()).await.is_empty());
}

// Catches touching an earlier volume before a later volume's manifest has passed capacity checks.
#[cfg(unix)]
#[tokio::test]
async fn manifest_capacity_preflights_later_volumes_before_any_mutation() {
    let (storage, roots) = volume_fixture().await;
    let mut assets = video_files(roots[0].as_ref(), 0, 1).await;
    assets.extend(video_files(roots[1].as_ref(), 1, 4097).await);
    let operations = roots[0].as_ref().join(".operations");
    // An attempt to publish the first volume's manifest would return an I/O permission error.
    std::fs::set_permissions(&operations, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = removal::stage(&storage, "delete-series", &assets).await;
    std::fs::set_permissions(&operations, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        matches!(result, Err(MediaError::InvalidStorageKey)),
        "the later volume's capacity rejection must precede publication on the earlier volume"
    );
    for asset in assets {
        assert!(
            roots[asset.storage_volume as usize]
                .as_ref()
                .join(asset.storage_key)
                .is_file()
        );
    }
    for root in &roots {
        assert!(operation_directories(root.as_ref()).await.is_empty());
    }
}

// Catches removing the bounded recovery read when increasing the supported manifest size.
#[tokio::test]
async fn manifest_capacity_recovery_retains_oversized_manifest_evidence() {
    let database = support::TestDatabase::migrated("removal_large_hostile_manifest").await;
    let db = database.connection();
    let (storage, root) = storage_fixture().await;
    let storage: MediaStorageSet = storage.into();
    let assets = video_files(root.as_ref(), 0, 1).await;
    drop(
        removal::stage(&storage, "delete-series", &assets)
            .await
            .unwrap(),
    );
    let operation = operation_directories(root.as_ref()).await.remove(0);
    let path = operation.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["reason"] = json!("x".repeat(1024 * 1024));
    let oversized = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(&path, &oversized).unwrap();
    assert!(matches!(
        removal::recover(&db, &storage).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), oversized);
    assert_eq!(
        std::fs::read(operation.join("00000000.data")).unwrap(),
        b"episode-video"
    );
}

async fn series_across_volumes(
    db: &sea_orm::DatabaseConnection,
    roots: &[TempRoot; 3],
) -> (Uuid, Vec<media_asset::Model>) {
    let mut assets = Vec::new();
    for (volume, root) in roots.iter().enumerate() {
        let (key, purpose) = match volume {
            0 => ("poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", "poster"),
            1 => ("video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4", "video"),
            _ => ("video/cc/cccccccccccccccccccccccccccccccc.mp4", "video"),
        };
        let file = registered_file(root.as_ref(), key, &[volume as u8; 4]).await;
        assets.push(
            media_asset::ActiveModel {
                id: Set(file.asset_id),
                storage_volume: Set(volume as i32),
                storage_key: Set(key.into()),
                original_name: Set("asset.bin".into()),
                mime_type: Set("application/octet-stream".into()),
                byte_size: Set(4),
                purpose: Set(purpose.into()),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap(),
        );
    }
    let series_id = Uuid::new_v4();
    series::ActiveModel {
        id: Set(series_id),
        name: Set("Across three volumes".into()),
        poster_asset_id: Set(Some(assets[0].id)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let season_id = Uuid::new_v4();
    season::ActiveModel {
        id: Set(season_id),
        series_id: Set(series_id),
        number: Set(1),
    }
    .insert(db)
    .await
    .unwrap();
    for (index, asset) in assets[1..].iter().enumerate() {
        episode::ActiveModel {
            id: Set(Uuid::new_v4()),
            season_id: Set(season_id),
            number: Set(index as i32 + 1),
            name: Set(format!("Episode {}", index + 1)),
            video_asset_id: Set(Some(asset.id)),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
    (series_id, assets)
}

async fn assert_series_files_preserved(
    db: &sea_orm::DatabaseConnection,
    roots: &[TempRoot; 3],
    series_id: Uuid,
    assets: &[media_asset::Model],
) {
    assert!(
        series::Entity::find_by_id(series_id)
            .one(db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(season::Entity::find().all(db).await.unwrap().len(), 1);
    assert_eq!(episode::Entity::find().all(db).await.unwrap().len(), 2);
    for asset in assets {
        assert_eq!(
            media_asset::Entity::find_by_id(asset.id)
                .one(db)
                .await
                .unwrap()
                .as_ref(),
            Some(asset)
        );
        assert_eq!(
            std::fs::read(
                roots[asset.storage_volume as usize]
                    .as_ref()
                    .join(&asset.storage_key)
            )
            .unwrap(),
            [asset.storage_volume as u8; 4]
        );
    }
}

fn startup_config(roots: &[TempRoot; 3]) -> movie_harbor_api::config::Config {
    movie_harbor_api::config::Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dirs: roots.iter().map(|root| root.as_ref().to_owned()).collect(),
        media_disk_reserve_bytes: 1,
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

// Catches separate operation IDs, wrong manifest grouping, and startup only restoring volume 0.
#[tokio::test]
async fn multi_volume_startup_recovers_one_operation_across_all_volumes() {
    let database = support::TestDatabase::migrated("removal_multi_recover").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let mut owned = removal::load_owned_media(
        &db,
        &assets.iter().map(|asset| asset.id).collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    owned.sort_by_key(|asset| std::cmp::Reverse(asset.storage_volume));
    drop(
        removal::stage(&storage, "delete-series", &owned)
            .await
            .unwrap(),
    );
    let mut operation_ids = Vec::new();
    for (volume, root) in roots.iter().enumerate() {
        let operations = operation_directories(root.as_ref()).await;
        assert_eq!(operations.len(), 1);
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(operations[0].join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["entries"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["entries"][0]["storage_volume"], volume);
        assert_eq!(
            manifest["entries"][0]["asset_id"],
            assets[volume].id.to_string()
        );
        operation_ids.push(manifest["operation_id"].clone());
        assert!(!root.as_ref().join(&assets[volume].storage_key).exists());
    }
    assert_eq!(operation_ids[0], operation_ids[1]);
    assert_eq!(operation_ids[1], operation_ids[2]);
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    for root in &roots {
        assert!(operation_directories(root.as_ref()).await.is_empty());
    }
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    assert_series_files_preserved(&db, &roots, id, &assets).await;
}

// Catches lost manifests or files after commit when one volume cannot finish physical deletion.
#[cfg(unix)]
#[tokio::test]
async fn multi_volume_finish_failure_preserves_remaining_manifests_for_startup() {
    let database = support::TestDatabase::migrated("removal_multi_finish").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let ids = assets.iter().map(|asset| asset.id).collect::<Vec<_>>();
    let owned = removal::load_owned_media(&db, &ids).await.unwrap();
    let staged = removal::stage(&storage, "delete-series", &owned)
        .await
        .unwrap();
    let middle = operation_directories(roots[1].as_ref()).await.remove(0);
    std::fs::set_permissions(&middle, std::fs::Permissions::from_mode(0o500)).unwrap();
    let tx = db.begin().await.unwrap();
    series::Entity::delete_by_id(id).exec(&tx).await.unwrap();
    removal::delete_media_assets(&tx, &ids).await.unwrap();
    let result = removal::finish_delete_transaction::<()>(tx, staged, 3, Ok(())).await;
    std::fs::set_permissions(&middle, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(result, Err(removal::FinishDeleteError::Finalize)));
    assert!(
        series::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        media_asset::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(operation_directories(roots[0].as_ref()).await.is_empty());
    for root in &roots[1..] {
        let operations = operation_directories(root.as_ref()).await;
        assert_eq!(operations.len(), 1);
        assert!(operations[0].join("manifest.json").is_file());
        assert!(operations[0].join("00000000.data").is_file());
    }
    let orphan = registered_file(
        roots[2].as_ref(),
        "video/dd/dddddddddddddddddddddddddddddddd.mp4",
        b"untracked",
    )
    .await;
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    for (volume, root) in roots.iter().enumerate() {
        assert!(operation_directories(root.as_ref()).await.is_empty());
        assert!(!root.as_ref().join(&assets[volume].storage_key).exists());
    }
    assert_eq!(
        std::fs::read(roots[2].as_ref().join(orphan.storage_key)).unwrap(),
        b"untracked"
    );
}

// Catches restoring a staged file merely because its asset ID/key are referenced on another volume.
#[tokio::test]
async fn multi_volume_recovery_requires_the_exact_database_reference_tuple() {
    let database = support::TestDatabase::migrated("removal_multi_tuple").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let mut wrong_volume =
        registered_file(roots[1].as_ref(), &assets[0].storage_key, b"wrong-volume").await;
    wrong_volume.asset_id = assets[0].id;
    wrong_volume.storage_volume = 1;
    drop(
        removal::stage(&storage, "interrupted-replacement", &[wrong_volume])
            .await
            .unwrap(),
    );
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    assert!(!roots[1].as_ref().join(&assets[0].storage_key).exists());
    assert!(operation_directories(roots[1].as_ref()).await.is_empty());
}

// Catches accepting a manifest whose explicit volume disagrees with the scanned root.
#[tokio::test]
async fn multi_volume_recovery_rejects_explicit_wrong_volume() {
    let database = support::TestDatabase::migrated("removal_multi_wrong_volume").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let owned = removal::load_owned_media(&db, &[assets[0].id])
        .await
        .unwrap();
    drop(
        removal::stage(&storage, "interrupted-delete", &owned)
            .await
            .unwrap(),
    );
    let operation = operation_directories(roots[0].as_ref()).await.remove(0);
    let path = operation.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["entries"][0]["storage_volume"] = json!(1);
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let error = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .expect_err("wrong volume must reject startup");
    assert!(
        !error
            .to_string()
            .contains(roots[0].as_ref().to_str().unwrap())
    );
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_file());
    assert!(!roots[0].as_ref().join(&assets[0].storage_key).exists());
    assert!(
        series::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
}

// Catches legacy unnumbered manifests being interpreted as belonging to nonzero volumes.
#[tokio::test]
async fn multi_volume_recovery_rejects_missing_volume_on_nonzero_root() {
    let database = support::TestDatabase::migrated("removal_multi_missing_volume").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (_, assets) = series_across_volumes(&db, &roots).await;
    let owned = removal::load_owned_media(&db, &[assets[1].id])
        .await
        .unwrap();
    drop(
        removal::stage(&storage, "interrupted-delete", &owned)
            .await
            .unwrap(),
    );
    let operation = operation_directories(roots[1].as_ref()).await.remove(0);
    let path = operation.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("storage_volume");
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
            .await
            .is_err()
    );
    assert!(operation.join("manifest.json").is_file());
    assert_eq!(
        std::fs::read(operation.join("00000000.data")).unwrap(),
        [1_u8; 4]
    );
}

// Catches breaking upgrade recovery for legacy volume-0 removal manifests.
#[tokio::test]
async fn multi_volume_recovery_accepts_legacy_volume_zero_manifest() {
    let database = support::TestDatabase::migrated("removal_multi_legacy").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let owned = removal::load_owned_media(&db, &[assets[0].id])
        .await
        .unwrap();
    drop(
        removal::stage(&storage, "interrupted-delete", &owned)
            .await
            .unwrap(),
    );
    let operation = operation_directories(roots[0].as_ref()).await.remove(0);
    let path = operation.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("storage_volume");
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let _ = movie_harbor_api::app::build(db.clone(), &startup_config(&roots))
        .await
        .unwrap();
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    assert!(!operation.exists());
}

// Catches the volume-0-only safety gate and deletion that leaves any cascade-owned file behind.
#[tokio::test]
async fn multi_volume_series_delete_cleans_all_files_and_records() {
    let database = support::TestDatabase::migrated("removal_multi_success").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let result = delete_series(&db, &storage, id, 1).await.unwrap();
    assert_eq!(result.deleted_media_count, 3);
    assert!(series::Entity::find().all(&db).await.unwrap().is_empty());
    assert!(season::Entity::find().all(&db).await.unwrap().is_empty());
    assert!(episode::Entity::find().all(&db).await.unwrap().is_empty());
    assert!(
        media_asset::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .is_empty()
    );
    for asset in assets {
        let root = roots[asset.storage_volume as usize].as_ref();
        assert!(!root.join(&asset.storage_key).exists());
        assert!(operation_directories(root).await.is_empty());
    }
}

// Catches failing to restore already staged volumes when the last volume cannot rename its file.
#[cfg(unix)]
#[tokio::test]
async fn multi_volume_last_stage_failure_restores_files_and_database() {
    let database = support::TestDatabase::migrated("removal_multi_stage").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    let leaf = roots[2].as_ref().join("video/cc");
    std::fs::set_permissions(&leaf, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = delete_series(&db, &storage, id, 1).await;
    std::fs::set_permissions(&leaf, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(result, Err(SeriesError::MediaDelete)));
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    for root in &roots {
        assert!(operation_directories(root.as_ref()).await.is_empty());
    }
    assert_eq!(
        delete_series(&db, &storage, id, 1)
            .await
            .unwrap()
            .deleted_media_count,
        3
    );
}

// Catches committing a partial cascade or omitting cross-volume restore after a SQL failure.
#[tokio::test]
async fn multi_volume_database_failure_restores_all_staged_files() {
    let database = support::TestDatabase::migrated("removal_multi_database").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    db.execute_unprepared("CREATE FUNCTION reject_media_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected deletion failure'; END; $$; CREATE TRIGGER reject_media_delete BEFORE DELETE ON media_asset FOR EACH ROW EXECUTE FUNCTION reject_media_delete();").await.unwrap();
    assert!(matches!(
        delete_series(&db, &storage, id, 1).await,
        Err(SeriesError::MediaDelete)
    ));
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    for root in &roots {
        assert!(operation_directories(root.as_ref()).await.is_empty());
    }
    db.execute_unprepared("DROP TRIGGER reject_media_delete ON media_asset")
        .await
        .unwrap();
    assert_eq!(
        delete_series(&db, &storage, id, 1)
            .await
            .unwrap()
            .deleted_media_count,
        3
    );
}

// Catches treating a failed commit as success or failing to restore any of the staged volumes.
#[tokio::test]
async fn multi_volume_commit_failure_restores_all_staged_files() {
    let database = support::TestDatabase::migrated("removal_multi_commit").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (id, assets) = series_across_volumes(&db, &roots).await;
    db.execute_unprepared("CREATE FUNCTION reject_media_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END; $$; CREATE CONSTRAINT TRIGGER reject_media_commit AFTER DELETE ON media_asset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_media_commit();").await.unwrap();
    assert!(matches!(
        delete_series(&db, &storage, id, 1).await,
        Err(SeriesError::MediaDelete)
    ));
    assert_series_files_preserved(&db, &roots, id, &assets).await;
    for root in &roots {
        assert!(operation_directories(root.as_ref()).await.is_empty());
    }
}

// Catches scanning or restoring a configured root before discovering a referenced missing volume.
#[tokio::test]
async fn multi_volume_missing_referenced_volume_fails_before_recovery_touches_files() {
    let database = support::TestDatabase::migrated("removal_multi_missing_root").await;
    let db = database.connection();
    let (storage, roots) = volume_fixture().await;
    let (_, assets) = series_across_volumes(&db, &roots).await;
    let owned = removal::load_owned_media(
        &db,
        &assets.iter().map(|asset| asset.id).collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    drop(
        removal::stage(&storage, "delete-series", &owned)
            .await
            .unwrap(),
    );
    let only_zero = MediaStorageSet::from(storage.volume(0).unwrap().storage().clone());
    assert!(matches!(
        removal::recover(&db, &only_zero).await,
        Err(MediaError::UnconfiguredVolume(1 | 2))
    ));
    for (volume, root) in roots.iter().enumerate() {
        assert!(!root.as_ref().join(&assets[volume].storage_key).exists());
        let operations = operation_directories(root.as_ref()).await;
        assert_eq!(operations.len(), 1);
        assert!(operations[0].join("00000000.data").is_file());
        assert!(operations[0].join("manifest.json").is_file());
    }
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
    let staged = removal::stage(
        &storage.clone().into(),
        "delete-movie",
        std::slice::from_ref(&file),
    )
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
    let staged = removal::stage(
        &storage.clone().into(),
        "delete-movie",
        std::slice::from_ref(&file),
    )
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
    let staged = removal::stage(
        &storage.clone().into(),
        "delete-movie",
        std::slice::from_ref(&file),
    )
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

    let staged = removal::stage(
        &storage.clone().into(),
        "delete-movie",
        std::slice::from_ref(&asset),
    )
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

    let staged = removal::stage(&storage.clone().into(), "delete-movie", &[asset])
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
        removal::stage(
            &storage.clone().into(),
            "delete-episode",
            std::slice::from_ref(&asset)
        )
        .await,
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
        removal::stage(&storage.clone().into(), "delete-episode", &[asset]).await,
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
        removal::stage(
            &storage.clone().into(),
            "delete-series",
            &[first.clone(), second.clone()]
        )
        .await,
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
        storage_volume: 0,
        storage_key: "../outside".into(),
    };
    assert!(matches!(
        removal::stage(
            &storage.clone().into(),
            "delete-series",
            &[good.clone(), escaped]
        )
        .await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(root.as_ref().join(&good.storage_key).exists());

    let directory_key = "video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4";
    tokio::fs::create_dir_all(root.as_ref().join(directory_key))
        .await
        .unwrap();
    let directory = OwnedMedia {
        asset_id: Uuid::new_v4(),
        storage_volume: 0,
        storage_key: directory_key.into(),
    };
    assert!(matches!(
        removal::stage(
            &storage.clone().into(),
            "delete-series",
            &[good.clone(), directory]
        )
        .await,
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
        storage_volume: 0,
        storage_key: link_key.into(),
    };

    assert!(matches!(
        removal::stage(
            &storage.clone().into(),
            "delete-series",
            &[good.clone(), linked]
        )
        .await,
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
        storage_volume: 0,
        storage_key: "video/cc/cccccccccccccccccccccccccccccccc.mp4".into(),
    };

    removal::stage(
        &storage.clone().into(),
        "delete-episode",
        std::slice::from_ref(&missing),
    )
    .await
    .unwrap()
    .restore()
    .await
    .unwrap();
    removal::stage(
        &storage.clone().into(),
        "delete-episode",
        std::slice::from_ref(&missing),
    )
    .await
    .unwrap()
    .finish()
    .await
    .unwrap();
    removal::stage(&storage.clone().into(), "delete-episode", &[missing])
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
        removal::stage(
            &storage.clone().into(),
            "replace-media",
            std::slice::from_ref(&referenced),
        )
        .await
        .unwrap(),
    );
    drop(
        removal::stage(
            &storage.clone().into(),
            "delete-media",
            std::slice::from_ref(&discarded),
        )
        .await
        .unwrap(),
    );
    assert!(!root.as_ref().join(&referenced.storage_key).exists());
    assert_eq!(operation_directories(root.as_ref()).await.len(), 2);

    removal::recover(&db, &storage.clone().into())
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&referenced.storage_key))
            .await
            .unwrap(),
        b"referenced-poster"
    );
    assert!(!root.as_ref().join(&discarded.storage_key).exists());
    assert!(operation_directories(root.as_ref()).await.is_empty());

    removal::recover(&db, &storage.clone().into())
        .await
        .unwrap();
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
        removal::recover(&db, &storage.clone().into()).await,
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

    removal::recover(&db, &storage.clone().into())
        .await
        .unwrap();
    assert!(!empty_after_mkdir.exists());
    assert!(!interrupted_manifest.exists());
    assert!(!empty_after_close.exists());
    removal::recover(&db, &storage.clone().into())
        .await
        .unwrap();
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

    assert!(
        removal::recover(&db, &storage.clone().into())
            .await
            .is_err()
    );
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
        removal::recover(&db, &storage.clone().into()).await,
        Err(MediaError::InvalidStorageKey)
    ));
    assert!(!root.as_ref().join(&storage_key).exists());
    assert_eq!(std::fs::read(&outside).unwrap(), b"external");
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_symlink());
    let _ = std::fs::remove_file(outside);
}
