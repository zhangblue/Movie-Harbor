use super::{
    ChunkSource, LocalMediaStorage, MediaError, StoredFile,
    validation::{MediaKind, UploadPolicy},
};
use crate::entities::{episode, file_cleanup_job, media_asset, movie, series};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QuerySelect, Set, TransactionTrait,
    sea_query::{Expr, OnConflict},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub enum AttachmentTarget {
    MoviePoster { id: Uuid, version: i64 },
    MovieVideo { id: Uuid, version: i64 },
    SeriesPoster(Uuid),
    EpisodeVideo(Uuid),
}

impl AttachmentTarget {
    fn kind(self) -> MediaKind {
        match self {
            Self::MoviePoster { .. } | Self::SeriesPoster(_) => MediaKind::Poster,
            Self::MovieVideo { .. } | Self::EpisodeVideo(_) => MediaKind::Video,
        }
    }

    fn expected_version(self) -> Option<i64> {
        match self {
            Self::MoviePoster { version, .. } | Self::MovieVideo { version, .. } => Some(version),
            Self::SeriesPoster(_) | Self::EpisodeVideo(_) => None,
        }
    }
}

pub(crate) struct PendingAttachment {
    id: Uuid,
    target: AttachmentTarget,
    kind: MediaKind,
    original_name: String,
    stored: StoredFile,
    expected_version: Option<i64>,
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
    commit_attachment(db, pending).await
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
    if expected_version.is_some_and(|version| version <= 0) {
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
) -> Result<media_asset::Model, MediaError> {
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
    let asset = match result {
        Ok(asset) => asset,
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
    Ok(asset)
}

async fn replace_before_commit(
    tx: &DatabaseTransaction,
    target: AttachmentTarget,
    id: Uuid,
    kind: MediaKind,
    original_name: &str,
    stored: &StoredFile,
    expected_version: Option<i64>,
) -> Result<media_asset::Model, MediaError> {
    let asset = insert_asset(tx, id, kind, original_name, stored).await?;
    let old_id = switch_reference(tx, target, asset.id, expected_version).await?;
    if let Some(old_id) = old_id {
        file_cleanup_job::Entity::insert(file_cleanup_job::ActiveModel {
            id: Set(Uuid::new_v4()),
            media_asset_id: Set(old_id),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(file_cleanup_job::Column::MediaAssetId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(tx)
        .await?;
    }
    Ok(asset)
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
    expected_version: Option<i64>,
) -> Result<Option<Uuid>, MediaError> {
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
            if let Some(version) = expected_version
                && model.version != version
            {
                return Err(MediaError::VersionConflict);
            }
            let old = match target {
                AttachmentTarget::MoviePoster { .. } => model.poster_asset_id,
                _ => model.video_asset_id,
            };
            if let Some(version) = expected_version {
                let result = match target {
                    AttachmentTarget::MoviePoster { .. } => {
                        movie::Entity::update_many()
                            .col_expr(movie::Column::PosterAssetId, Expr::value(Some(new_id)))
                            .col_expr(movie::Column::Version, Expr::value(version + 1))
                            .col_expr(
                                movie::Column::UpdatedAt,
                                Expr::value(chrono::Utc::now().fixed_offset()),
                            )
                            .filter(movie::Column::Id.eq(model.id))
                            .filter(movie::Column::Version.eq(version))
                            .exec(tx)
                            .await?
                    }
                    AttachmentTarget::MovieVideo { .. } => {
                        movie::Entity::update_many()
                            .col_expr(movie::Column::VideoAssetId, Expr::value(Some(new_id)))
                            .col_expr(movie::Column::Version, Expr::value(version + 1))
                            .col_expr(
                                movie::Column::UpdatedAt,
                                Expr::value(chrono::Utc::now().fixed_offset()),
                            )
                            .filter(movie::Column::Id.eq(model.id))
                            .filter(movie::Column::Version.eq(version))
                            .exec(tx)
                            .await?
                    }
                    _ => unreachable!(),
                };
                if result.rows_affected != 1 {
                    return Err(MediaError::VersionConflict);
                }
            } else {
                let mut active = model.into_active_model();
                match target {
                    AttachmentTarget::MoviePoster { .. } => {
                        active.poster_asset_id = Set(Some(new_id))
                    }
                    AttachmentTarget::MovieVideo { .. } => {
                        active.video_asset_id = Set(Some(new_id))
                    }
                    _ => unreachable!(),
                }
                active.updated_at = Set(chrono::Utc::now().fixed_offset());
                active.update(tx).await?;
            }
            Ok(old)
        }
        AttachmentTarget::SeriesPoster(id) => {
            let model = series::Entity::find_by_id(id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            let old = model.poster_asset_id;
            let mut active = model.into_active_model();
            active.poster_asset_id = Set(Some(new_id));
            active.updated_at = Set(chrono::Utc::now().fixed_offset());
            active.update(tx).await?;
            Ok(old)
        }
        AttachmentTarget::EpisodeVideo(id) => {
            let model = episode::Entity::find_by_id(id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            let old = model.video_asset_id;
            let mut active = model.into_active_model();
            active.video_asset_id = Set(Some(new_id));
            active.updated_at = Set(chrono::Utc::now().fixed_offset());
            active.update(tx).await?;
            Ok(old)
        }
    }
}
