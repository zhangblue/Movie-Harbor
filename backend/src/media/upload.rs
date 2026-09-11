use super::{
    ChunkSource, LocalMediaStorage, MediaError, StoredFile,
    references::{lock_for_reference_removal, queue_locked_if_unreferenced},
    validation::{MediaKind, UploadPolicy},
};
use crate::entities::{episode, media_asset, movie, season, series};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    QueryFilter, QuerySelect, Set, TransactionTrait, sea_query::Expr,
};
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
    expected_version: i64,
}

pub(crate) struct CommittedAttachment {
    pub asset: media_asset::Model,
    pub version: i64,
    pub series_version: Option<i64>,
}

struct SwitchOutcome {
    old_id: Option<Uuid>,
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
    stored.notify_database_committed()?;
    tokio::task::yield_now().await;
    stored.mark_registered()?;
    Ok(asset)
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
    let stored = storage
        .store(id, kind, original_name, declared_mime, policy, source)
        .await?;
    Ok(PendingAttachment {
        id,
        target,
        kind,
        original_name: original_name.to_owned(),
        stored,
        expected_version,
    })
}

pub(crate) async fn commit_attachment(
    db: &DatabaseConnection,
    mut pending: PendingAttachment,
) -> Result<CommittedAttachment, MediaError> {
    let tx = db.begin().await?;
    pending.stored.begin_database_write();
    let result = replace_before_commit(
        &tx,
        pending.target,
        pending.id,
        pending.kind,
        &pending.original_name,
        &pending.stored,
        pending.expected_version,
    )
    .await;
    let committed = match result {
        Ok(committed) => committed,
        Err(error) => {
            if tx.rollback().await.is_ok() {
                pending.stored.database_failure_is_known();
            }
            return Err(error);
        }
    };
    tx.commit().await?;
    pending.stored.notify_database_committed()?;
    tokio::task::yield_now().await;
    pending.stored.mark_registered()?;
    Ok(committed)
}

async fn replace_before_commit(
    tx: &DatabaseTransaction,
    target: AttachmentTarget,
    id: Uuid,
    kind: MediaKind,
    original_name: &str,
    stored: &StoredFile,
    expected_version: i64,
) -> Result<CommittedAttachment, MediaError> {
    let asset = insert_asset(tx, id, kind, original_name, stored).await?;
    let outcome = switch_reference(tx, target, asset.id, expected_version).await?;
    let removed_assets = outcome.old_id.into_iter().collect::<Vec<_>>();
    queue_locked_if_unreferenced(tx, &removed_assets).await?;
    Ok(CommittedAttachment {
        asset,
        version: outcome.version,
        series_version: outcome.series_version,
    })
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
            lock_for_reference_removal(tx, old).await?;
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
            Ok(SwitchOutcome {
                old_id: old,
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
            lock_for_reference_removal(tx, old).await?;
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
            Ok(SwitchOutcome {
                old_id: old,
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
            lock_for_reference_removal(tx, old).await?;
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
            Ok(SwitchOutcome {
                old_id: old,
                version: version + 1,
                series_version: Some(parent.version + 1),
            })
        }
    }
}
