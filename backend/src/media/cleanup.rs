use super::{LocalMediaStorage, MediaError};
use crate::entities::{episode, file_cleanup_job, media_asset, movie, series};
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait, sea_query::Expr,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const BATCH_SIZE: u64 = 100;
const MAX_ERROR_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CleanupOutcome {
    pub succeeded: usize,
    pub failed: usize,
}

pub async fn run_once(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
) -> Result<CleanupOutcome, MediaError> {
    let jobs = file_cleanup_job::Entity::find()
        .filter(Expr::col(file_cleanup_job::Column::NextAttemptAt).lte(Expr::current_timestamp()))
        .order_by_asc(file_cleanup_job::Column::CreatedAt)
        .limit(BATCH_SIZE)
        .all(db)
        .await?;
    let mut outcome = CleanupOutcome::default();
    for job in jobs {
        if process_job(db, storage, job.id).await? {
            outcome.succeeded += 1;
        } else {
            outcome.failed += 1;
        }
    }
    Ok(outcome)
}

pub async fn recover_uploads(
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
            if !registered && let Err(error) = storage.remove_pending_owned(&marker).await {
                eprintln!("retaining unproven media recovery marker: {error}");
                continue;
            }
            storage.remove_incoming(&entry.name).await?;
        }
    }
    storage.notify_recovery_cycle_completed()?;
    Ok(())
}

async fn process_job(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    job_id: Uuid,
) -> Result<bool, MediaError> {
    let tx = db.begin().await?;
    let Some(job) = file_cleanup_job::Entity::find_by_id(job_id)
        .lock_exclusive()
        .one(&tx)
        .await?
    else {
        tx.commit().await?;
        return Ok(true);
    };
    let attempt = process_locked_job(&tx, storage, &job).await;
    if let Err(error) = attempt {
        if matches!(error, MediaError::Database(_)) {
            return Err(error);
        }
        let mut active = job.into_active_model();
        active.attempts = Set(active.attempts.as_ref().saturating_add(1));
        active.last_error = Set(Some(sanitize_error(&error)));
        active.next_attempt_at = Set((Utc::now() + ChronoDuration::minutes(5)).fixed_offset());
        active.update(&tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}

async fn process_locked_job(
    tx: &DatabaseTransaction,
    storage: &LocalMediaStorage,
    job: &file_cleanup_job::Model,
) -> Result<(), MediaError> {
    let asset = media_asset::Entity::find_by_id(job.media_asset_id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(MediaError::InvalidStorageKey)?;
    ensure_unreferenced(tx, asset.id).await?;
    storage
        .remove_registered(
            &asset.storage_key,
            asset.byte_size,
            asset.checksum_sha256.as_deref(),
        )
        .await?;
    file_cleanup_job::Entity::delete_by_id(job.id)
        .exec(tx)
        .await?;
    media_asset::Entity::delete_by_id(asset.id).exec(tx).await?;
    Ok(())
}

async fn ensure_unreferenced(tx: &DatabaseTransaction, asset_id: Uuid) -> Result<(), MediaError> {
    let movie_reference = movie::Entity::find()
        .filter(
            movie::Column::PosterAssetId
                .eq(asset_id)
                .or(movie::Column::VideoAssetId.eq(asset_id)),
        )
        .one(tx)
        .await?;
    let series_reference = series::Entity::find()
        .filter(series::Column::PosterAssetId.eq(asset_id))
        .one(tx)
        .await?;
    let episode_reference = episode::Entity::find()
        .filter(episode::Column::VideoAssetId.eq(asset_id))
        .one(tx)
        .await?;
    if movie_reference.is_some() || series_reference.is_some() || episode_reference.is_some() {
        return Err(MediaError::StillReferenced);
    }
    Ok(())
}

fn sanitize_error(error: &MediaError) -> String {
    let mut result = String::new();
    for character in error
        .to_string()
        .chars()
        .filter(|character| !character.is_control())
    {
        if result.len() + character.len_utf8() > MAX_ERROR_BYTES {
            break;
        }
        result.push(character);
    }
    result
}

pub fn spawn(db: DatabaseConnection, storage: LocalMediaStorage) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = recover_uploads(&db, &storage, Duration::from_secs(3600)).await {
                eprintln!("media upload recovery failed: {error}");
            }
            if let Err(error) = run_once(&db, &storage).await {
                eprintln!("media cleanup worker failed: {error}");
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    })
}
