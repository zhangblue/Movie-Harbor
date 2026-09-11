use super::{LocalMediaStorage, MediaError};
use crate::entities::{episode, file_cleanup_job, media_asset, movie, series};
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait, sea_query::Expr,
};
use std::time::Duration;
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
        match process_job(db, storage, job.id).await {
            Ok(()) => outcome.succeeded += 1,
            Err(error) => {
                record_failure(db, job.id, &error).await?;
                outcome.failed += 1;
            }
        }
    }
    Ok(outcome)
}

async fn process_job(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    job_id: Uuid,
) -> Result<(), MediaError> {
    let tx = db.begin().await?;
    let Some(job) = file_cleanup_job::Entity::find_by_id(job_id)
        .lock_exclusive()
        .one(&tx)
        .await?
    else {
        return Ok(());
    };
    let asset = media_asset::Entity::find_by_id(job.media_asset_id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(MediaError::InvalidStorageKey)?;
    ensure_unreferenced(&tx, asset.id).await?;
    storage.remove_registered(&asset.storage_key).await?;
    file_cleanup_job::Entity::delete_by_id(job.id)
        .exec(&tx)
        .await?;
    media_asset::Entity::delete_by_id(asset.id)
        .exec(&tx)
        .await?;
    tx.commit().await?;
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

async fn record_failure(
    db: &DatabaseConnection,
    job_id: Uuid,
    error: &MediaError,
) -> Result<(), MediaError> {
    let Some(job) = file_cleanup_job::Entity::find_by_id(job_id).one(db).await? else {
        return Ok(());
    };
    let mut active = job.into_active_model();
    active.attempts = Set(active.attempts.as_ref().saturating_add(1));
    active.last_error = Set(Some(sanitize_error(error)));
    active.next_attempt_at = Set((Utc::now() + ChronoDuration::minutes(5)).fixed_offset());
    active.update(db).await?;
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

pub fn spawn(db: DatabaseConnection, storage: LocalMediaStorage) {
    tokio::spawn(async move {
        loop {
            let _ = run_once(&db, &storage).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}
