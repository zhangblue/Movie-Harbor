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
/// 待删除的资产标识及存储键，供暂存和恢复流程定位文件。
pub struct OwnedMedia {
    pub asset_id: Uuid,
    pub storage_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
/// 持久化删除清单，供中断后核验操作并恢复文件。
struct Manifest {
    version: u8,
    operation_id: Uuid,
    reason: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
/// 删除清单中的文件条目，供恢复时核对原键与隔离名称。
struct ManifestEntry {
    asset_id: Uuid,
    storage_key: String,
    staged_name: String,
}

/// 已隔离文件的运行时记录，供回滚或最终清理使用。
struct StagedEntry {
    source: RemovalSource,
    staged_name: String,
}

/// 持有媒体变更锁的删除暂存结果，供事务结束后恢复或清理。
pub struct StagedRemoval {
    storage: LocalMediaStorage,
    staged: StagedOperation,
    _guard: OwnedMutexGuard<()>,
}

#[derive(Debug)]
/// 删除收尾错误，供调用方区分操作、恢复、提交和清理失败。
pub enum FinishDeleteError<E> {
    Operation(E),
    Restore,
    Commit,
    Finalize,
}

/// 删除暂存操作，供持锁会话恢复或完成隔离文件。
pub(crate) struct StagedOperation {
    _operation_id: Uuid,
    operation: RemovalOperation,
    entries: Vec<StagedEntry>,
}

/// 持有媒体变更锁的会话，供删除及替换流程协调暂存。
pub(crate) struct RemovalSession {
    storage: LocalMediaStorage,
    guard: OwnedMutexGuard<()>,
}

impl StagedRemoval {
    /// 在删除事务未成功时恢复隔离文件并关闭操作。
    pub async fn restore(self) -> Result<(), MediaError> {
        self.staged.restore(&self.storage)
    }

    /// 在删除事务成功后移除隔离文件并关闭操作。
    pub async fn finish(self) -> Result<(), MediaError> {
        self.staged.finish(&self.storage)
    }
}

impl StagedOperation {
    /// 在删除事务未成功时恢复隔离文件并关闭操作。
    pub(crate) fn restore(self, storage: &LocalMediaStorage) -> Result<(), MediaError> {
        for entry in self.entries.iter().rev() {
            storage.restore_removal_source(&self.operation, &entry.source, &entry.staged_name)?;
        }
        storage.close_removal_operation(&self.operation)
    }

    /// 在删除事务成功后移除隔离文件并关闭操作。
    pub(crate) fn finish(self, storage: &LocalMediaStorage) -> Result<(), MediaError> {
        for entry in &self.entries {
            storage.finish_removal_source(&self.operation, &entry.staged_name)?;
        }
        storage.close_removal_operation(&self.operation)
    }
}

/// 在删除或替换前获取变更锁并隔离受影响文件，供事务结束后处理。
pub async fn stage(
    storage: &LocalMediaStorage,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<StagedRemoval, MediaError> {
    // 返回值持有全局媒体变更锁，直到恢复或完成删除，避免删除与上传、替换交错。
    acquire(storage).await?.stage(reason, assets)
}

/// 在删除或替换前按资产标识读取需暂存的媒体键。
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

/// 在删除事务中批量移除已暂存文件对应的资产记录。
pub async fn delete_media_assets<C: ConnectionTrait>(db: &C, ids: &[Uuid]) -> Result<(), DbErr> {
    if !ids.is_empty() {
        media_asset::Entity::delete_many()
            .filter(media_asset::Column::Id.is_in(ids.iter().copied()))
            .exec(db)
            .await?;
    }
    Ok(())
}

/// 在删除操作完成数据库写入后协调提交、文件恢复和最终清理。
pub async fn finish_delete_transaction<E>(
    tx: DatabaseTransaction,
    staged: StagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), E>,
) -> Result<u64, FinishDeleteError<E>> {
    // 明确的提交前操作失败才回滚并恢复；提交结果未知时保留隔离副本和清单，交启动恢复判断。
    if let Err(error) = database_result {
        let _ = tx.rollback().await;
        staged
            .restore()
            .await
            .map_err(|_| FinishDeleteError::Restore)?;
        return Err(FinishDeleteError::Operation(error));
    }
    if tx.commit().await.is_err() {
        // Drop only releases the mutation lock; durable evidence must survive an uncertain COMMIT.
        return Err(FinishDeleteError::Commit);
    }
    staged
        .finish()
        .await
        .map_err(|_| FinishDeleteError::Finalize)?;
    Ok(deleted_media_count as u64)
}

/// 在应用启动时依据持久删除清单和数据库引用恢复或完成中断操作。
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

/// 在删除恢复时核对资产及存储键是否仍被内容或暂存海报引用。
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
                    UNION ALL SELECT 1 FROM mcp_staged_poster WHERE asset_id = a.id
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

/// 在媒体删除或恢复开始时取得全局变更锁。
pub(crate) async fn acquire(storage: &LocalMediaStorage) -> Result<RemovalSession, MediaError> {
    Ok(RemovalSession {
        storage: storage.clone(),
        guard: storage.lock_removal().await?,
    })
}

/// 在附件替换已持有变更锁时延续删除会话，避免重复加锁。
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
    /// 在删除或替换事务中隔离受影响文件，并将当前会话持有的全局变更锁移交给暂存结果。
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

    /// 在替换旧媒体时暂存文件并保留当前会话锁。
    pub(crate) fn stage_retaining(
        &self,
        reason: &str,
        assets: &[OwnedMedia],
    ) -> Result<StagedOperation, MediaError> {
        stage_operation(&self.storage, reason, assets)
    }

    /// 在删除会话结束或回退时交还其持有的媒体变更锁。
    pub(crate) fn into_guard(self) -> OwnedMutexGuard<()> {
        self.guard
    }
}

/// 在删除会话中持久化清单并隔离目标文件，失败时恢复已暂存项。
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
