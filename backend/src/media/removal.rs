use super::{
    LocalMediaStorage, MediaError, MediaStorageSet,
    storage::{MAX_REMOVAL_MANIFEST_BYTES, RemovalOperation, RemovalSource},
};
use crate::entities::media_asset;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr,
    EntityTrait, QueryFilter, QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

const MAX_REMOVAL_MANIFEST_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedMedia {
    pub asset_id: Uuid,
    pub storage_volume: i32,
    pub storage_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u8,
    operation_id: Uuid,
    reason: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestEntry {
    asset_id: Uuid,
    // Legacy v1 manifests belong to volume 0. New manifests always serialize this field.
    #[serde(default)]
    storage_volume: i32,
    storage_key: String,
    staged_name: String,
}

struct StagedEntry {
    source: RemovalSource,
    staged_name: String,
}

struct PreparedOperation {
    encoded_manifest: Vec<u8>,
    entries: Vec<StagedEntry>,
}

pub struct MultiVolumeStagedRemoval {
    staged: StagedOperations,
    _guard: OwnedMutexGuard<()>,
}

pub(crate) struct StagedOperations {
    operations: Vec<(i32, LocalMediaStorage, StagedOperation)>,
}

#[derive(Debug)]
pub enum FinishDeleteError<E> {
    Operation(E),
    Restore,
    Commit,
    Finalize,
}

struct StagedOperation {
    _operation_id: Uuid,
    operation: RemovalOperation,
    entries: Vec<StagedEntry>,
}

pub(crate) struct RemovalSession {
    storage: MediaStorageSet,
    guard: OwnedMutexGuard<()>,
}

impl MultiVolumeStagedRemoval {
    pub async fn restore(self) -> Result<(), MediaError> {
        self.staged.restore()
    }

    pub async fn finish(self) -> Result<(), MediaError> {
        self.staged.finish()
    }
}

impl StagedOperations {
    pub(crate) fn restore(self) -> Result<(), MediaError> {
        let mut failure = None;
        for (_, storage, staged) in self.operations.into_iter().rev() {
            if let Err(error) = staged.restore(&storage) {
                // Keep restoring earlier volumes even when a later volume needs startup recovery.
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(crate) fn finish(self) -> Result<(), MediaError> {
        for (_, storage, staged) in self.operations {
            staged.finish(&storage)?;
        }
        Ok(())
    }
}

impl StagedOperation {
    pub(crate) fn restore(self, storage: &LocalMediaStorage) -> Result<(), MediaError> {
        for entry in self.entries.iter().rev() {
            storage.restore_removal_source(&self.operation, &entry.source, &entry.staged_name)?;
        }
        storage.close_removal_operation(&self.operation)
    }

    pub(crate) fn finish(self, storage: &LocalMediaStorage) -> Result<(), MediaError> {
        for entry in &self.entries {
            storage.finish_removal_source(&self.operation, &entry.staged_name)?;
        }
        storage.close_removal_operation(&self.operation)
    }
}

pub async fn stage(
    storage: &MediaStorageSet,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<MultiVolumeStagedRemoval, MediaError> {
    acquire(storage).await?.stage(reason, assets)
}

pub async fn load_owned_media<C: ConnectionTrait>(
    db: &C,
    ids: &[Uuid],
) -> Result<Vec<OwnedMedia>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(media_asset::Entity::find()
        .filter(media_asset::Column::Id.is_in(ids.iter().copied()))
        .all(db)
        .await?
        .into_iter()
        .map(|asset| OwnedMedia {
            asset_id: asset.id,
            storage_volume: asset.storage_volume,
            storage_key: asset.storage_key,
        })
        .collect())
}

pub async fn delete_media_assets<C: ConnectionTrait>(db: &C, ids: &[Uuid]) -> Result<(), DbErr> {
    if !ids.is_empty() {
        media_asset::Entity::delete_many()
            .filter(media_asset::Column::Id.is_in(ids.iter().copied()))
            .exec(db)
            .await?;
    }
    Ok(())
}

pub async fn finish_delete_transaction<E>(
    tx: DatabaseTransaction,
    staged: MultiVolumeStagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), E>,
) -> Result<u64, FinishDeleteError<E>> {
    if let Err(error) = database_result {
        let _ = tx.rollback().await;
        staged
            .restore()
            .await
            .map_err(|_| FinishDeleteError::Restore)?;
        return Err(FinishDeleteError::Operation(error));
    }
    if tx.commit().await.is_err() {
        staged
            .restore()
            .await
            .map_err(|_| FinishDeleteError::Restore)?;
        return Err(FinishDeleteError::Commit);
    }
    staged
        .finish()
        .await
        .map_err(|_| FinishDeleteError::Finalize)?;
    Ok(deleted_media_count as u64)
}

pub async fn recover(db: &DatabaseConnection, storage: &MediaStorageSet) -> Result<(), MediaError> {
    let _guard = storage.acquire_removal().await?;
    let registered_volumes: Vec<i32> = media_asset::Entity::find()
        .select_only()
        .column(media_asset::Column::StorageVolume)
        .distinct()
        .into_tuple()
        .all(db)
        .await?;
    for volume in registered_volumes {
        if storage.volume(volume).is_none() {
            return Err(MediaError::UnconfiguredVolume(volume));
        }
    }
    for volume in storage.volumes() {
        recover_volume(db, volume.storage(), volume.volume_id()).await?;
    }
    Ok(())
}

async fn recover_volume(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    volume_id: i32,
) -> Result<(), MediaError> {
    for persisted in storage.persisted_removal_operations()? {
        let manifest: Manifest = serde_json::from_slice(&persisted.manifest)
            .map_err(|_| MediaError::InvalidStorageKey)?;
        if manifest.version != 1
            || manifest.operation_id.simple().to_string() != persisted.operation.name
            || manifest.entries.len() > MAX_REMOVAL_MANIFEST_ENTRIES
        {
            return Err(MediaError::InvalidStorageKey);
        }
        for (index, entry) in manifest.entries.iter().enumerate() {
            if entry.storage_volume != volume_id || entry.staged_name != format!("{index:08}.data")
            {
                return Err(MediaError::InvalidStorageKey);
            }
            storage.validate_storage_key(&entry.storage_key)?;
            storage.validate_persisted_removal_entry(&persisted.operation, &entry.staged_name)?;
        }
        for entry in &manifest.entries {
            if is_referenced(db, entry.asset_id, entry.storage_volume, &entry.storage_key).await? {
                storage.restore_persisted_removal(
                    &persisted.operation,
                    &entry.storage_key,
                    &entry.staged_name,
                )?;
            } else {
                storage.finish_removal_source(&persisted.operation, &entry.staged_name)?;
            }
        }
        storage.close_removal_operation(&persisted.operation)?;
    }
    Ok(())
}

async fn is_referenced(
    db: &DatabaseConnection,
    asset_id: Uuid,
    storage_volume: i32,
    storage_key: &str,
) -> Result<bool, MediaError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT EXISTS (
                SELECT 1 FROM media_asset a
                WHERE a.id = $1 AND a.storage_volume = $2 AND a.storage_key = $3 AND EXISTS (
                    SELECT 1 FROM movie WHERE poster_asset_id = a.id OR video_asset_id = a.id
                    UNION ALL SELECT 1 FROM series WHERE poster_asset_id = a.id
                    UNION ALL SELECT 1 FROM episode WHERE video_asset_id = a.id
                )
            ) AS referenced"#,
            [asset_id.into(), storage_volume.into(), storage_key.into()],
        ))
        .await?
        .ok_or(MediaError::Database(sea_orm::DbErr::RecordNotFound(
            "recovery reference result".into(),
        )))?;
    row.try_get::<bool>("", "referenced")
        .map_err(MediaError::Database)
}

pub(crate) async fn acquire(storage: &MediaStorageSet) -> Result<RemovalSession, MediaError> {
    Ok(RemovalSession {
        storage: storage.clone(),
        guard: storage.acquire_removal().await?,
    })
}

pub(crate) fn continue_with_guard(
    storage: &MediaStorageSet,
    guard: OwnedMutexGuard<()>,
) -> RemovalSession {
    RemovalSession {
        storage: storage.clone(),
        guard,
    }
}

impl RemovalSession {
    pub(crate) fn stage(
        self,
        reason: &str,
        assets: &[OwnedMedia],
    ) -> Result<MultiVolumeStagedRemoval, MediaError> {
        let Self { storage, guard } = self;
        let staged = stage_operations(&storage, reason, assets)?;
        Ok(MultiVolumeStagedRemoval {
            staged,
            _guard: guard,
        })
    }

    pub(crate) fn stage_retaining(
        &self,
        reason: &str,
        assets: &[OwnedMedia],
    ) -> Result<StagedOperations, MediaError> {
        stage_operations(&self.storage, reason, assets)
    }

    pub(crate) fn into_guard(self) -> OwnedMutexGuard<()> {
        self.guard
    }
}

fn stage_operations(
    storage: &MediaStorageSet,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<StagedOperations, MediaError> {
    let mut groups: BTreeMap<i32, Vec<&OwnedMedia>> = BTreeMap::new();
    for asset in assets {
        // Resolve every referenced volume before touching any file.
        if storage.volume(asset.storage_volume).is_none() {
            return Err(MediaError::UnconfiguredVolume(asset.storage_volume));
        }
        groups.entry(asset.storage_volume).or_default().push(asset);
    }
    let operation_id = Uuid::new_v4();
    let mut prepared = Vec::new();
    // Validate every volume's serialized manifest before publishing any manifest or renaming files.
    for (volume_id, assets) in groups {
        let volume = storage
            .volume(volume_id)
            .ok_or(MediaError::UnconfiguredVolume(volume_id))?;
        prepared.push((
            volume_id,
            volume.storage().clone(),
            prepare_operation(volume.storage(), operation_id, reason, &assets)?,
        ));
    }
    let mut staged = StagedOperations {
        operations: Vec::new(),
    };
    for (volume_id, storage, prepared) in prepared {
        match stage_operation(&storage, operation_id, prepared) {
            Ok(operation) => staged.operations.push((volume_id, storage, operation)),
            Err(error) => {
                staged.restore()?;
                return Err(error);
            }
        }
    }
    Ok(staged)
}

fn prepare_operation(
    storage: &LocalMediaStorage,
    operation_id: Uuid,
    reason: &str,
    assets: &[&OwnedMedia],
) -> Result<PreparedOperation, MediaError> {
    let mut prepared = Vec::new();
    for asset in assets {
        if let Some(source) = storage.prepare_removal(&asset.storage_key)? {
            prepared.push((asset, source));
            if prepared.len() > MAX_REMOVAL_MANIFEST_ENTRIES {
                return Err(MediaError::InvalidStorageKey);
            }
        }
    }

    let manifest = Manifest {
        version: 1,
        operation_id,
        reason: reason.to_owned(),
        entries: prepared
            .iter()
            .enumerate()
            .map(|(index, (asset, _))| ManifestEntry {
                asset_id: asset.asset_id,
                storage_volume: asset.storage_volume,
                storage_key: asset.storage_key.clone(),
                staged_name: format!("{index:08}.data"),
            })
            .collect(),
    };
    let encoded = serde_json::to_vec(&manifest).map_err(std::io::Error::other)?;
    if encoded.len() > MAX_REMOVAL_MANIFEST_BYTES {
        return Err(MediaError::InvalidStorageKey);
    }
    let entries = prepared
        .into_iter()
        .zip(&manifest.entries)
        .map(|((_, source), manifest_entry)| StagedEntry {
            source,
            staged_name: manifest_entry.staged_name.clone(),
        })
        .collect();
    Ok(PreparedOperation {
        encoded_manifest: encoded,
        entries,
    })
}

fn stage_operation(
    storage: &LocalMediaStorage,
    operation_id: Uuid,
    prepared: PreparedOperation,
) -> Result<StagedOperation, MediaError> {
    let PreparedOperation {
        encoded_manifest,
        entries,
    } = prepared;
    let operation = storage.create_removal_operation(operation_id, &encoded_manifest)?;
    for (index, current) in entries.iter().enumerate() {
        if let Err(error) =
            storage.stage_removal_source(&operation, &current.source, &current.staged_name)
        {
            for entry in entries[..=index].iter().rev() {
                storage.restore_removal_source(&operation, &entry.source, &entry.staged_name)?;
            }
            storage.close_removal_operation(&operation)?;
            return Err(error);
        }
    }
    Ok(StagedOperation {
        _operation_id: operation_id,
        operation,
        entries,
    })
}
