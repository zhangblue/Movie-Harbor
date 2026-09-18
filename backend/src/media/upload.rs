use super::{
    ChunkSource, LocalMediaStorage, MediaError, StoredFile,
    removal::{self, OwnedMedia, RemovalSession, StagedOperation},
    validation::{MediaKind, UploadPolicy},
};
use crate::entities::{episode, media_asset, movie, season, series};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    QueryFilter, QuerySelect, Set, TransactionTrait, sea_query::Expr,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub enum AttachmentTarget {
    MoviePoster { id: Uuid, version: i64 },
    MovieVideo { id: Uuid, version: i64 },
    SeriesPoster { id: Uuid, version: i64 },
    EpisodeVideo { id: Uuid, version: i64 },
}

impl AttachmentTarget {
    fn kind(self) -> MediaKind {
        match self {
            Self::MoviePoster { .. } | Self::SeriesPoster { .. } => MediaKind::Poster,
            Self::MovieVideo { .. } | Self::EpisodeVideo { .. } => MediaKind::Video,
        }
    }

    fn expected_version(self) -> i64 {
        match self {
            Self::MoviePoster { version, .. }
            | Self::MovieVideo { version, .. }
            | Self::SeriesPoster { version, .. }
            | Self::EpisodeVideo { version, .. } => version,
        }
    }
}

pub(crate) struct PendingAttachment {
    id: Uuid,
    target: AttachmentTarget,
    kind: MediaKind,
    original_name: String,
    stored: StoredFile,
    storage: LocalMediaStorage,
    expected_version: i64,
}

pub(crate) struct CommittedAttachment {
    pub asset: media_asset::Model,
    pub version: i64,
    pub series_version: Option<i64>,
}

struct SwitchOutcome {
    version: i64,
    series_version: Option<i64>,
}

pub async fn store_new_asset<S: ChunkSource + Send>(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    kind: MediaKind,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
    source: S,
) -> Result<media_asset::Model, MediaError> {
    let id = Uuid::new_v4();
    let mut stored = storage
        .store(id, kind, original_name, declared_mime, policy, source)
        .await?;
    // 先持久化恢复标记再进入数据库写阶段，使“文件已提升但引用尚未提交”的中断可在启动时收敛。
    stored.begin_database_write();
    let asset = match insert_asset(db, id, kind, original_name, &stored).await {
        Ok(asset) => asset,
        Err(error) => {
            if media_asset::Entity::find_by_id(id).one(db).await?.is_none() {
                stored.database_failure_is_known();
            }
            return Err(error);
        }
    };
    // 数据库记录提交后才移除恢复标记并注册文件，避免崩溃窗口遗留无法判定的已提升文件。
    stored.notify_database_committed()?;
    tokio::task::yield_now().await;
    stored.mark_registered()?;
    Ok(asset)
}

pub async fn recover_stale_uploads(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    stale_age: Duration,
) -> Result<(), MediaError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    for entry in storage.incoming_entries()? {
        let modified = u64::try_from(entry.modified_unix_seconds).unwrap_or(0);
        if now.saturating_sub(modified) < stale_age.as_secs() {
            continue;
        }
        if entry.name.ends_with(".part") {
            storage.remove_incoming(&entry.name).await?;
            continue;
        }
        if entry.name.ends_with(".pending") {
            let marker = match storage.read_pending_marker(&entry.name) {
                Ok(marker) => marker,
                Err(error) => {
                    eprintln!("retaining invalid media recovery marker: {error}");
                    continue;
                }
            };
            let registered = media_asset::Entity::find()
                .filter(media_asset::Column::StorageKey.eq(marker.storage_key.clone()))
                .one(db)
                .await?
                .is_some();
            if !registered {
                match storage.remove_pending_owned(&marker).await {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(error) => {
                        eprintln!("retaining unproven media recovery marker: {error}");
                        continue;
                    }
                }
            }
            storage.remove_incoming(&entry.name).await?;
        }
    }
    storage.notify_recovery_cycle_completed()?;
    Ok(())
}

pub async fn replace_attachment<S: ChunkSource + Send>(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    target: AttachmentTarget,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
    source: S,
) -> Result<media_asset::Model, MediaError> {
    let pending = prepare_attachment(
        storage,
        target,
        original_name,
        declared_mime,
        policy,
        source,
    )
    .await?;
    Ok(commit_attachment(db, pending).await?.asset)
}

pub(crate) async fn prepare_attachment<S: ChunkSource + Send>(
    storage: &LocalMediaStorage,
    target: AttachmentTarget,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
    source: S,
) -> Result<PendingAttachment, MediaError> {
    let expected_version = target.expected_version();
    if expected_version <= 0 {
        return Err(MediaError::InvalidVersion);
    }
    let id = Uuid::new_v4();
    let kind = target.kind();
    // 替换也先按流式上传策略完整写入新文件；旧引用在后续事务成功前保持不变。
    let stored = storage
        .store(id, kind, original_name, declared_mime, policy, source)
        .await?;
    Ok(PendingAttachment {
        id,
        target,
        kind,
        original_name: original_name.to_owned(),
        stored,
        storage: storage.clone(),
        expected_version,
    })
}

pub(crate) async fn commit_attachment(
    db: &DatabaseConnection,
    mut pending: PendingAttachment,
) -> Result<CommittedAttachment, MediaError> {
    // 新文件携带的全局媒体变更锁覆盖数据库切换、旧文件暂存和提交后注册，避免并发操作打破槽位独占。
    let guard = pending.stored.take_mutation_guard()?;
    let removal = removal::continue_with_guard(&pending.storage, guard);
    let mut staged = None;
    let tx = match db.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            pending.stored.return_mutation_guard(removal.into_guard())?;
            return Err(error.into());
        }
    };
    pending.stored.begin_database_write();
    let result = replace_before_commit(&tx, &pending, &removal, &mut staged).await;
    let committed = match result {
        Ok(committed) => committed,
        Err(error) => {
            if tx.rollback().await.is_ok() {
                pending.stored.database_failure_is_known();
            }
            let restore_result = staged
                .take()
                .map(|staged| staged.restore(&pending.storage))
                .transpose();
            pending.stored.return_mutation_guard(removal.into_guard())?;
            restore_result.map_err(|_| MediaError::ReplacementFailed)?;
            return Err(error);
        }
    };
    if tx.commit().await.is_err() {
        pending.stored.database_failure_is_known();
        let restore_result = staged
            .take()
            .map(|staged| staged.restore(&pending.storage))
            .transpose();
        pending.stored.return_mutation_guard(removal.into_guard())?;
        restore_result.map_err(|_| MediaError::ReplacementFailed)?;
        return Err(MediaError::ReplacementFailed);
    }
    // 先确认新资产数据库提交并注册，再不可逆地清理旧资产隔离副本；两类 finalize 失败保持不同错误语义。
    pending
        .stored
        .notify_database_committed()
        .map_err(|_| MediaError::ReplacementFinalizationFailed)?;
    tokio::task::yield_now().await;
    pending
        .stored
        .mark_registered()
        .map_err(|_| MediaError::ReplacementFinalizationFailed)?;
    if let Some(staged) = staged {
        staged
            .finish(&pending.storage)
            .map_err(|_| MediaError::ReplacementFinalizationFailed)?;
    }
    Ok(CommittedAttachment {
        asset: committed.asset,
        version: committed.version,
        series_version: committed.series_version,
    })
}

async fn replace_before_commit(
    tx: &DatabaseTransaction,
    pending: &PendingAttachment,
    removal: &RemovalSession,
    staged: &mut Option<StagedOperation>,
) -> Result<CommittedAttachment, MediaError> {
    // 新资产登记、归属槽位切换和旧资产记录删除共用一个事务，避免媒体资产被多个槽位同时引用。
    let asset = insert_asset(
        tx,
        pending.id,
        pending.kind,
        &pending.original_name,
        &pending.stored,
    )
    .await?;
    let outcome = switch_reference(
        tx,
        pending.target,
        asset.id,
        pending.expected_version,
        removal,
        staged,
    )
    .await?;
    let committed = CommittedAttachment {
        asset,
        version: outcome.version,
        series_version: outcome.series_version,
    };
    Ok(committed)
}

async fn insert_asset<C: sea_orm::ConnectionTrait>(
    db: &C,
    id: Uuid,
    kind: MediaKind,
    original_name: &str,
    stored: &StoredFile,
) -> Result<media_asset::Model, MediaError> {
    Ok(media_asset::ActiveModel {
        id: Set(id),
        storage_key: Set(stored.storage_key.clone()),
        original_name: Set(original_name.to_owned()),
        mime_type: Set(stored.mime_type.clone()),
        byte_size: Set(stored.byte_size),
        purpose: Set(kind.purpose().to_owned()),
        checksum_sha256: Set(Some(stored.checksum_sha256.clone())),
        ..Default::default()
    }
    .insert(db)
    .await?)
}

async fn switch_reference(
    tx: &DatabaseTransaction,
    target: AttachmentTarget,
    new_id: Uuid,
    expected_version: i64,
    removal: &RemovalSession,
    staged: &mut Option<StagedOperation>,
) -> Result<SwitchOutcome, MediaError> {
    // 每个槽位先锁定其归属对象并重检版本；单集路径额外锁定祖先以维持层级写入顺序。
    match target {
        AttachmentTarget::MoviePoster { id, .. } | AttachmentTarget::MovieVideo { id, .. } => {
            let model = movie::Entity::find_by_id(id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            if model.version != expected_version {
                return Err(MediaError::VersionConflict);
            }
            let old = match target {
                AttachmentTarget::MoviePoster { .. } => model.poster_asset_id,
                _ => model.video_asset_id,
            };
            let old_to_delete = stage_old_asset(tx, removal, staged, old).await?;
            let database_result: Result<(), MediaError> = async {
                let result = match target {
                    AttachmentTarget::MoviePoster { .. } => {
                        movie::Entity::update_many()
                            .col_expr(movie::Column::PosterAssetId, Expr::value(Some(new_id)))
                            .col_expr(movie::Column::Version, Expr::value(expected_version + 1))
                            .col_expr(
                                movie::Column::UpdatedAt,
                                Expr::value(chrono::Utc::now().fixed_offset()),
                            )
                            .filter(movie::Column::Id.eq(model.id))
                            .filter(movie::Column::Version.eq(expected_version))
                            .exec(tx)
                            .await?
                    }
                    AttachmentTarget::MovieVideo { .. } => {
                        movie::Entity::update_many()
                            .col_expr(movie::Column::VideoAssetId, Expr::value(Some(new_id)))
                            .col_expr(movie::Column::Version, Expr::value(expected_version + 1))
                            .col_expr(
                                movie::Column::UpdatedAt,
                                Expr::value(chrono::Utc::now().fixed_offset()),
                            )
                            .filter(movie::Column::Id.eq(model.id))
                            .filter(movie::Column::Version.eq(expected_version))
                            .exec(tx)
                            .await?
                    }
                    _ => unreachable!(),
                };
                if result.rows_affected != 1 {
                    return Err(MediaError::VersionConflict);
                }
                delete_old_asset(tx, old_to_delete).await
            }
            .await;
            database_result?;
            Ok(SwitchOutcome {
                version: expected_version + 1,
                series_version: None,
            })
        }
        AttachmentTarget::SeriesPoster { id, version } => {
            let model = series::Entity::find_by_id(id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            if model.version != version {
                return Err(MediaError::VersionConflict);
            }
            let old = model.poster_asset_id;
            let old_to_delete = stage_old_asset(tx, removal, staged, old).await?;
            let database_result: Result<(), MediaError> = async {
                let result = series::Entity::update_many()
                    .col_expr(series::Column::PosterAssetId, Expr::value(Some(new_id)))
                    .col_expr(series::Column::Version, Expr::value(version + 1))
                    .col_expr(
                        series::Column::UpdatedAt,
                        Expr::value(chrono::Utc::now().fixed_offset()),
                    )
                    .filter(series::Column::Id.eq(model.id))
                    .filter(series::Column::Version.eq(version))
                    .exec(tx)
                    .await?;
                if result.rows_affected != 1 {
                    return Err(MediaError::VersionConflict);
                }
                delete_old_asset(tx, old_to_delete).await
            }
            .await;
            database_result?;
            Ok(SwitchOutcome {
                version: version + 1,
                series_version: None,
            })
        }
        AttachmentTarget::EpisodeVideo { id, version } => {
            // 先读取不可变祖先，再按全局顺序锁住全部内容记录：series -> season -> episode。
            // 加锁后重新核对每条父子关系，避免并发移动或删除使先前读取的层级失效。
            let episode_hint = episode::Entity::find_by_id(id)
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            let season_hint = season::Entity::find_by_id(episode_hint.season_id)
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            let parent = series::Entity::find_by_id(season_hint.series_id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            let season = season::Entity::find()
                .filter(season::Column::Id.eq(season_hint.id))
                .filter(season::Column::SeriesId.eq(parent.id))
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            let model = episode::Entity::find()
                .filter(episode::Column::Id.eq(id))
                .filter(episode::Column::SeasonId.eq(season.id))
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            if model.version != version {
                return Err(MediaError::VersionConflict);
            }
            let old = model.video_asset_id;
            let old_to_delete = stage_old_asset(tx, removal, staged, old).await?;
            let database_result: Result<(), MediaError> = async {
                let episode_result = episode::Entity::update_many()
                    .col_expr(episode::Column::VideoAssetId, Expr::value(Some(new_id)))
                    .col_expr(episode::Column::Version, Expr::value(version + 1))
                    .col_expr(
                        episode::Column::UpdatedAt,
                        Expr::value(chrono::Utc::now().fixed_offset()),
                    )
                    .filter(episode::Column::Id.eq(model.id))
                    .filter(episode::Column::Version.eq(version))
                    .exec(tx)
                    .await?;
                if episode_result.rows_affected != 1 {
                    return Err(MediaError::VersionConflict);
                }
                let parent_result = series::Entity::update_many()
                    .col_expr(series::Column::Version, Expr::value(parent.version + 1))
                    .col_expr(
                        series::Column::UpdatedAt,
                        Expr::value(chrono::Utc::now().fixed_offset()),
                    )
                    .filter(series::Column::Id.eq(parent.id))
                    .filter(series::Column::Version.eq(parent.version))
                    .exec(tx)
                    .await?;
                if parent_result.rows_affected != 1 {
                    return Err(MediaError::VersionConflict);
                }
                delete_old_asset(tx, old_to_delete).await
            }
            .await;
            database_result?;
            Ok(SwitchOutcome {
                version: version + 1,
                series_version: Some(parent.version + 1),
            })
        }
    }
}

async fn stage_old_asset(
    tx: &DatabaseTransaction,
    removal: &RemovalSession,
    staged: &mut Option<StagedOperation>,
    old_id: Option<Uuid>,
) -> Result<Option<Uuid>, MediaError> {
    let Some(old_id) = old_id else {
        return Ok(None);
    };
    let old = media_asset::Entity::find_by_id(old_id)
        .one(tx)
        .await?
        .ok_or(MediaError::TargetNotFound)?;
    // 数据库引用切换前先将旧文件隔离；事务未提交时可恢复，提交后才允许同步删除。
    *staged = Some(
        removal
            .stage_retaining(
                "replace-media",
                &[OwnedMedia {
                    asset_id: old.id,
                    storage_key: old.storage_key,
                }],
            )
            .map_err(|_| MediaError::ReplacementFailed)?,
    );
    Ok(Some(old_id))
}

async fn delete_old_asset(
    tx: &DatabaseTransaction,
    old_id: Option<Uuid>,
) -> Result<(), MediaError> {
    let Some(old_id) = old_id else {
        return Ok(());
    };
    // 旧文件已隔离且新引用已写入同一事务后，才删除旧资产记录以保持全局槽位独占。
    let deleted = media_asset::Entity::delete_by_id(old_id).exec(tx).await?;
    if deleted.rows_affected != 1 {
        return Err(MediaError::ReplacementFailed);
    }
    Ok(())
}
