use super::{
    ChunkSource, MediaError, MediaStorageSet, VolumeStoredFile,
    removal::{self, OwnedMedia, RemovalSession, StagedOperations},
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
    stored: VolumeStoredFile,
    storage: MediaStorageSet,
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
    storage: &MediaStorageSet,
    kind: MediaKind,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
    source: S,
) -> Result<media_asset::Model, MediaError> {
    let id = Uuid::new_v4();
    let mut stored = storage
        .store(
            policy.max_bytes(),
            id,
            kind,
            original_name,
            declared_mime,
            policy,
            source,
        )
        .await?;
    stored.stored.begin_database_write();
    let asset = match insert_asset(db, id, kind, original_name, &stored).await {
        Ok(asset) => asset,
        Err(error) => {
            if media_asset::Entity::find_by_id(id).one(db).await?.is_none() {
                stored.stored.database_failure_is_known();
            }
            return Err(error);
        }
    };
    stored.stored.notify_database_committed()?;
    tokio::task::yield_now().await;
    stored.stored.mark_registered()?;
    Ok(asset)
}

pub async fn recover_stale_uploads(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    stale_age: Duration,
) -> Result<(), MediaError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    for volume in storage.volumes() {
        let storage = volume.storage();
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
                    .filter(media_asset::Column::StorageVolume.eq(volume.volume_id()))
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
    }
    Ok(())
}

pub async fn replace_attachment<S: ChunkSource + Send>(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
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
        policy.max_bytes(),
        source,
    )
    .await?;
    Ok(commit_attachment(db, pending).await?.asset)
}

pub(crate) async fn prepare_attachment<S: ChunkSource + Send>(
    storage: &MediaStorageSet,
    target: AttachmentTarget,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
    required_bytes: u64,
    source: S,
) -> Result<PendingAttachment, MediaError> {
    let expected_version = target.expected_version();
    if expected_version <= 0 {
        return Err(MediaError::InvalidVersion);
    }
    let id = Uuid::new_v4();
    let kind = target.kind();
    let stored = storage
        .store(
            required_bytes,
            id,
            kind,
            original_name,
            declared_mime,
            policy,
            source,
        )
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
    let guard = pending.stored.stored.take_mutation_guard()?;
    let mut removal = removal::continue_with_guard(&pending.storage, guard);
    let mut staged = None;
    let tx = match db.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            pending
                .stored
                .stored
                .return_mutation_guard(removal.into_guard())?;
            return Err(error.into());
        }
    };
    pending.stored.stored.begin_database_write();
    let result = replace_before_commit(&tx, &pending, &mut removal, &mut staged).await;
    let committed = match result {
        Ok(committed) => committed,
        Err(error) => {
            if tx.rollback().await.is_ok() {
                pending.stored.stored.database_failure_is_known();
            }
            let restore_result = staged.take().map(StagedOperations::restore).transpose();
            pending
                .stored
                .stored
                .return_mutation_guard(removal.into_guard())?;
            restore_result.map_err(|_| MediaError::ReplacementFailed)?;
            return Err(error);
        }
    };
    if tx.commit().await.is_err() {
        pending.stored.stored.database_failure_is_known();
        let restore_result = staged.take().map(StagedOperations::restore).transpose();
        pending
            .stored
            .stored
            .return_mutation_guard(removal.into_guard())?;
        restore_result.map_err(|_| MediaError::ReplacementFailed)?;
        return Err(MediaError::ReplacementFailed);
    }
    pending
        .stored
        .stored
        .notify_database_committed()
        .map_err(|_| MediaError::ReplacementFinalizationFailed)?;
    tokio::task::yield_now().await;
    pending
        .stored
        .stored
        .mark_registered()
        .map_err(|_| MediaError::ReplacementFinalizationFailed)?;
    if let Some(staged) = staged {
        staged
            .finish()
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
    removal: &mut RemovalSession,
    staged: &mut Option<StagedOperations>,
) -> Result<CommittedAttachment, MediaError> {
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
    stored: &VolumeStoredFile,
) -> Result<media_asset::Model, MediaError> {
    Ok(media_asset::ActiveModel {
        id: Set(id),
        storage_volume: Set(stored.volume_id),
        storage_key: Set(stored.stored.storage_key.clone()),
        original_name: Set(original_name.to_owned()),
        mime_type: Set(stored.stored.mime_type.clone()),
        byte_size: Set(stored.stored.byte_size),
        purpose: Set(kind.purpose().to_owned()),
        checksum_sha256: Set(Some(stored.stored.checksum_sha256.clone())),
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
    removal: &mut RemovalSession,
    staged: &mut Option<StagedOperations>,
) -> Result<SwitchOutcome, MediaError> {
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
            // Discover immutable ancestry, then acquire every content lock in the global order
            // series -> season -> episode. Re-check each edge after locking.
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
    removal: &mut RemovalSession,
    staged: &mut Option<StagedOperations>,
    old_id: Option<Uuid>,
) -> Result<Option<Uuid>, MediaError> {
    let Some(old_id) = old_id else {
        return Ok(None);
    };
    let old = media_asset::Entity::find_by_id(old_id)
        .one(tx)
        .await?
        .ok_or(MediaError::TargetNotFound)?;
    *staged = Some(
        removal
            .stage_retaining(
                "replace-media",
                &[OwnedMedia {
                    asset_id: old.id,
                    storage_volume: old.storage_volume,
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
    let deleted = media_asset::Entity::delete_by_id(old_id).exec(tx).await?;
    if deleted.rows_affected != 1 {
        return Err(MediaError::ReplacementFailed);
    }
    Ok(())
}
