use super::{
    ChunkSource, LocalMediaStorage, MediaError, StoredFile,
    validation::{MediaKind, UploadPolicy},
};
use crate::entities::{episode, file_cleanup_job, media_asset, movie, series};
use sea_orm::{
    ActiveModelTrait, DatabaseConnection, DatabaseTransaction, EntityTrait, IntoActiveModel,
    QuerySelect, Set, TransactionTrait,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub enum AttachmentTarget {
    MoviePoster(Uuid),
    MovieVideo(Uuid),
    SeriesPoster(Uuid),
    EpisodeVideo(Uuid),
}

impl AttachmentTarget {
    fn kind(self) -> MediaKind {
        match self {
            Self::MoviePoster(_) | Self::SeriesPoster(_) => MediaKind::Poster,
            Self::MovieVideo(_) | Self::EpisodeVideo(_) => MediaKind::Video,
        }
    }
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
    let stored = storage
        .store(id, kind, original_name, declared_mime, policy, source)
        .await?;
    match insert_asset(db, id, kind, original_name, stored.clone()).await {
        Ok(asset) => Ok(asset),
        Err(error) => {
            let _ = storage.remove_registered(&stored.storage_key).await;
            Err(error)
        }
    }
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
    let id = Uuid::new_v4();
    let kind = target.kind();
    let stored = storage
        .store(id, kind, original_name, declared_mime, policy, source)
        .await?;
    let result = replace_in_transaction(db, target, id, kind, original_name, stored.clone()).await;
    if result.is_err() {
        let _ = storage.remove_registered(&stored.storage_key).await;
    }
    result
}

async fn replace_in_transaction(
    db: &DatabaseConnection,
    target: AttachmentTarget,
    id: Uuid,
    kind: MediaKind,
    original_name: &str,
    stored: StoredFile,
) -> Result<media_asset::Model, MediaError> {
    let tx = db.begin().await?;
    let asset = insert_asset(&tx, id, kind, original_name, stored).await?;
    let old_id = switch_reference(&tx, target, asset.id).await?;
    if let Some(old_id) = old_id {
        file_cleanup_job::ActiveModel {
            id: Set(Uuid::new_v4()),
            media_asset_id: Set(old_id),
            ..Default::default()
        }
        .insert(&tx)
        .await?;
    }
    tx.commit().await?;
    Ok(asset)
}

async fn insert_asset<C: sea_orm::ConnectionTrait>(
    db: &C,
    id: Uuid,
    kind: MediaKind,
    original_name: &str,
    stored: StoredFile,
) -> Result<media_asset::Model, MediaError> {
    Ok(media_asset::ActiveModel {
        id: Set(id),
        storage_key: Set(stored.storage_key),
        original_name: Set(original_name.to_owned()),
        mime_type: Set(stored.mime_type),
        byte_size: Set(stored.byte_size),
        purpose: Set(kind.purpose().to_owned()),
        checksum_sha256: Set(Some(stored.checksum_sha256)),
        ..Default::default()
    }
    .insert(db)
    .await?)
}

async fn switch_reference(
    tx: &DatabaseTransaction,
    target: AttachmentTarget,
    new_id: Uuid,
) -> Result<Option<Uuid>, MediaError> {
    match target {
        AttachmentTarget::MoviePoster(id) | AttachmentTarget::MovieVideo(id) => {
            let model = movie::Entity::find_by_id(id)
                .lock_exclusive()
                .one(tx)
                .await?
                .ok_or(MediaError::TargetNotFound)?;
            if model.status != "draft" {
                return Err(MediaError::ReadOnly);
            }
            let old = match target {
                AttachmentTarget::MoviePoster(_) => model.poster_asset_id,
                _ => model.video_asset_id,
            };
            let mut active = model.into_active_model();
            match target {
                AttachmentTarget::MoviePoster(_) => active.poster_asset_id = Set(Some(new_id)),
                AttachmentTarget::MovieVideo(_) => active.video_asset_id = Set(Some(new_id)),
                _ => unreachable!(),
            }
            active.updated_at = Set(chrono::Utc::now().fixed_offset());
            active.update(tx).await?;
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
