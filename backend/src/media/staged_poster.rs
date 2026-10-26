use super::{ChunkSource, LocalMediaStorage, MediaError, UploadPolicy};
use crate::auth::csrf;
use crate::entities::{mcp_staged_poster, media_asset};
use chrono::{DateTime, FixedOffset};
use rand_core::{OsRng, RngCore};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use serde::Serialize;
use uuid::Uuid;

pub const STAGED_POSTER_TTL: chrono::Duration = chrono::Duration::minutes(30);
pub const STAGE_CLEANUP_LIMIT: u64 = 25;
pub const STARTUP_CLEANUP_LIMIT: u64 = 1000;

pub struct StagePosterCommand<'a, S> {
    pub db: &'a DatabaseConnection,
    pub storage: &'a LocalMediaStorage,
    pub policy: &'a UploadPolicy,
    pub principal_hash: &'a str,
    pub original_name: &'a str,
    pub declared_mime: &'a str,
    pub source: S,
}
#[derive(Serialize)]
pub struct StagedPosterResponse {
    pub token: String,
    pub format: String,
    pub byte_size: i64,
    pub expires_at: DateTime<FixedOffset>,
}
#[derive(Debug)]
pub struct StagedPosterAsset {
    pub asset: media_asset::Model,
}
#[derive(Debug)]
pub enum StagedPosterError {
    NotFound,
    Media(MediaError),
}
impl From<MediaError> for StagedPosterError {
    fn from(error: MediaError) -> Self {
        Self::Media(error)
    }
}
impl From<sea_orm::DbErr> for StagedPosterError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Media(error.into())
    }
}
impl std::fmt::Display for StagedPosterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("staged poster not found"),
            Self::Media(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for StagedPosterError {}
impl axum::response::IntoResponse for StagedPosterError {
    fn into_response(self) -> axum::response::Response {
        match self {
            Self::NotFound => (
                axum::http::StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({"error":"staged poster not found"})),
            )
                .into_response(),
            Self::Media(error) => error.into_response(),
        }
    }
}
pub async fn stage<S: ChunkSource + Send>(
    command: StagePosterCommand<'_, S>,
) -> Result<StagedPosterResponse, StagedPosterError> {
    let now = chrono::Utc::now().fixed_offset();
    cleanup_expired(command.db, command.storage, now, STAGE_CLEANUP_LIMIT).await?;
    let pending = super::upload::prepare_new_asset(
        command.storage,
        super::MediaKind::Poster,
        command.original_name,
        command.declared_mime,
        command.policy,
        command.source,
    )
    .await?;
    stage_prepared(command.db, command.principal_hash, pending).await
}

pub(crate) async fn stage_prepared(
    db: &DatabaseConnection,
    principal_hash: &str,
    pending: super::upload::PreparedNewAsset,
) -> Result<StagedPosterResponse, StagedPosterError> {
    let now = chrono::Utc::now().fixed_offset();
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let token = format!(
        "mhposter_{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let expires_at = now + STAGED_POSTER_TTL;
    let token_hash = csrf::digest(&token);
    let principal_hash = principal_hash.to_owned();
    let asset = super::upload::register_new_asset(db, pending, move |tx, asset| {
        Box::pin(async move {
            mcp_staged_poster::ActiveModel {
                id: Set(Uuid::new_v4()),
                token_hash: Set(token_hash),
                principal_hash: Set(principal_hash),
                asset_id: Set(asset.id),
                created_at: Set(now),
                expires_at: Set(expires_at),
            }
            .insert(tx)
            .await?;
            Ok(())
        })
    })
    .await?;
    Ok(StagedPosterResponse {
        token,
        format: asset
            .mime_type
            .strip_prefix("image/")
            .unwrap_or(&asset.mime_type)
            .to_owned(),
        byte_size: asset.byte_size,
        expires_at,
    })
}

/// Call inside the content-write transaction: rollback restores the token's consumability.
pub async fn lock_for_consumption<C: ConnectionTrait>(
    db: &C,
    raw_token: &str,
    principal_hash: &str,
    now: DateTime<FixedOffset>,
) -> Result<StagedPosterAsset, StagedPosterError> {
    let row = mcp_staged_poster::Entity::find()
        .filter(mcp_staged_poster::Column::TokenHash.eq(csrf::digest(raw_token)))
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or(StagedPosterError::NotFound)?;
    if row.principal_hash != principal_hash || row.expires_at <= now {
        return Err(StagedPosterError::NotFound);
    }
    let asset = media_asset::Entity::find_by_id(row.asset_id)
        .one(db)
        .await?
        .ok_or(StagedPosterError::NotFound)?;
    let deleted = mcp_staged_poster::Entity::delete_by_id(row.id)
        .exec(db)
        .await?;
    if deleted.rows_affected != 1 {
        return Err(StagedPosterError::NotFound);
    }
    Ok(StagedPosterAsset { asset })
}

pub async fn cleanup_expired(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    now: DateTime<FixedOffset>,
    limit: u64,
) -> Result<u64, StagedPosterError> {
    if limit == 0 {
        return Ok(0);
    }
    let tx = db.begin().await?;
    let rows = mcp_staged_poster::Entity::find()
        .filter(mcp_staged_poster::Column::ExpiresAt.lte(now))
        .order_by_asc(mcp_staged_poster::Column::ExpiresAt)
        .order_by_asc(mcp_staged_poster::Column::Id)
        .limit(limit)
        .lock_exclusive()
        .all(&tx)
        .await?;
    if rows.is_empty() {
        tx.rollback().await?;
        return Ok(0);
    }
    let ids: Vec<_> = rows.iter().map(|row| row.asset_id).collect();
    let owned = super::removal::load_owned_media(&tx, &ids).await?;
    let staged = super::removal::stage(storage, "expired-mcp-staged-posters", &owned).await?;
    let result: Result<(), MediaError> = async {
        mcp_staged_poster::Entity::delete_many()
            .filter(mcp_staged_poster::Column::Id.is_in(rows.iter().map(|row| row.id)))
            .exec(&tx)
            .await?;
        super::removal::delete_media_assets(&tx, &ids).await?;
        Ok(())
    }
    .await;
    super::removal::finish_delete_transaction(tx, staged, rows.len(), result)
        .await
        .map_err(|error| match error {
            super::removal::FinishDeleteError::Operation(error) => error.into(),
            super::removal::FinishDeleteError::Restore => MediaError::Io(std::io::Error::other(
                "staged poster cleanup restoration failed",
            ))
            .into(),
            super::removal::FinishDeleteError::Commit => {
                MediaError::Io(std::io::Error::other("staged poster cleanup commit failed")).into()
            }
            super::removal::FinishDeleteError::Finalize => MediaError::Io(std::io::Error::other(
                "staged poster cleanup finalization failed",
            ))
            .into(),
        })
}
