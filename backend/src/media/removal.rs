use super::{
    LocalMediaStorage, MediaError,
    storage::{RemovalOperation, RemovalSource},
};
use crate::entities::media_asset;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr,
    EntityTrait, QueryFilter, Statement,
};
use serde::{Deserialize, Serialize};
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedMedia {
    pub asset_id: Uuid,
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
    storage_key: String,
    staged_name: String,
}

struct StagedEntry {
    source: RemovalSource,
    staged_name: String,
}

pub struct StagedRemoval {
    storage: LocalMediaStorage,
    staged: StagedOperation,
    _guard: OwnedMutexGuard<()>,
}

#[derive(Debug)]
pub enum FinishDeleteError<E> {
    Operation(E),
    Restore,
    Commit,
    Finalize,
}

pub(crate) struct StagedOperation {
    _operation_id: Uuid,
    operation: RemovalOperation,
    entries: Vec<StagedEntry>,
}

pub(crate) struct RemovalSession {
    storage: LocalMediaStorage,
    guard: OwnedMutexGuard<()>,
}

impl StagedRemoval {
    pub async fn restore(self) -> Result<(), MediaError> {
        self.staged.restore(&self.storage)
    }

    pub async fn finish(self) -> Result<(), MediaError> {
        self.staged.finish(&self.storage)
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
    storage: &LocalMediaStorage,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<StagedRemoval, MediaError> {
    // 返回值持有全局媒体变更锁，直到恢复或完成删除，避免删除与上传、替换交错。
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
    staged: StagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), E>,
) -> Result<u64, FinishDeleteError<E>> {
    // 事务回滚或提交失败时恢复可见文件；只有提交成功后才同步清理隔离副本，并单独报告 finalize 失败。
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

pub async fn recover(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
) -> Result<(), MediaError> {
    // 启动恢复只检查持久清单明确登记的中断操作，不扫描或清理普通孤儿文件。
    let _session = acquire(storage).await?;
    for persisted in storage.persisted_removal_operations()? {
        let manifest: Manifest = serde_json::from_slice(&persisted.manifest)
            .map_err(|_| MediaError::InvalidStorageKey)?;
        if manifest.version != 1
            || manifest.operation_id.simple().to_string() != persisted.operation.name
            || manifest.entries.len() > 4096
        {
            return Err(MediaError::InvalidStorageKey);
        }
        for (index, entry) in manifest.entries.iter().enumerate() {
            if entry.staged_name != format!("{index:08}.data") {
                return Err(MediaError::InvalidStorageKey);
            }
            storage.validate_storage_key(&entry.storage_key)?;
            storage.validate_persisted_removal_entry(&persisted.operation, &entry.staged_name)?;
        }
        for entry in &manifest.entries {
            // 数据库仍引用该资产则恢复原位置；引用已切换或删除后才完成隔离副本的物理清理。
            if is_referenced(db, entry.asset_id, &entry.storage_key).await? {
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
    storage_key: &str,
) -> Result<bool, MediaError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT EXISTS (
                SELECT 1 FROM media_asset a
                WHERE a.id = $1 AND a.storage_key = $2 AND EXISTS (
                    SELECT 1 FROM movie WHERE poster_asset_id = a.id OR video_asset_id = a.id
                    UNION ALL SELECT 1 FROM series WHERE poster_asset_id = a.id
                    UNION ALL SELECT 1 FROM episode WHERE video_asset_id = a.id
                )
            ) AS referenced"#,
            [asset_id.into(), storage_key.into()],
        ))
        .await?
        .ok_or(MediaError::Database(sea_orm::DbErr::RecordNotFound(
            "recovery reference result".into(),
        )))?;
    row.try_get::<bool>("", "referenced")
        .map_err(MediaError::Database)
}

pub(crate) async fn acquire(storage: &LocalMediaStorage) -> Result<RemovalSession, MediaError> {
    Ok(RemovalSession {
        storage: storage.clone(),
        guard: storage.lock_removal().await?,
    })
}

pub(crate) fn continue_with_guard(
    storage: &LocalMediaStorage,
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
    ) -> Result<StagedRemoval, MediaError> {
        let Self { storage, guard } = self;
        let staged = stage_operation(&storage, reason, assets)?;
        Ok(StagedRemoval {
            storage,
            staged,
            _guard: guard,
        })
    }

    pub(crate) fn stage_retaining(
        &self,
        reason: &str,
        assets: &[OwnedMedia],
    ) -> Result<StagedOperation, MediaError> {
        stage_operation(&self.storage, reason, assets)
    }

    pub(crate) fn into_guard(self) -> OwnedMutexGuard<()> {
        self.guard
    }
}

fn stage_operation(
    storage: &LocalMediaStorage,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<StagedOperation, MediaError> {
    let mut prepared = Vec::new();
    for asset in assets {
        if let Some(source) = storage.prepare_removal(&asset.storage_key)? {
            prepared.push((asset, source));
        }
    }

    // 全部目标预检通过后先持久化删除清单，再原子暂存文件，使崩溃恢复能够收敛已登记的状态。
    let operation_id = Uuid::new_v4();
    let manifest = Manifest {
        version: 1,
        operation_id,
        reason: reason.to_owned(),
        entries: prepared
            .iter()
            .enumerate()
            .map(|(index, (asset, _))| ManifestEntry {
                asset_id: asset.asset_id,
                storage_key: asset.storage_key.clone(),
                staged_name: format!("{index:08}.data"),
            })
            .collect(),
    };
    let encoded = serde_json::to_vec(&manifest).map_err(std::io::Error::other)?;
    let operation = storage.create_removal_operation(operation_id, &encoded)?;
    let mut entries: Vec<StagedEntry> = Vec::new();
    for ((_, source), manifest_entry) in prepared.into_iter().zip(&manifest.entries) {
        entries.push(StagedEntry {
            source,
            staged_name: manifest_entry.staged_name.clone(),
        });
        let current = entries
            .last()
            .expect("the current removal entry was pushed");
        if let Err(error) =
            storage.stage_removal_source(&operation, &current.source, &current.staged_name)
        {
            // 任一文件暂存失败即按相反顺序恢复已移动文件，并移除本次操作清单。
            for entry in entries.iter().rev() {
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
