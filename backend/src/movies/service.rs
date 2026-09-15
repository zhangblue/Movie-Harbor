use crate::{
    content::{
        ContentRuleError, TargetState, apply_optional_i32, apply_target_state, apply_text,
        ensure_transition, normalize_required, parse_target, parse_unique_uuids,
        require_positive_i64, require_version,
    },
    entities::movie,
    genres,
    media::{MediaStorageSet, is_publishable_asset, removal},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    Set, TransactionTrait,
};
use std::collections::HashSet;
use uuid::Uuid;

use super::{
    dto::{
        DeleteImpactResponse, DeleteResultResponse, MovieListQuery, MovieResponse,
        UpdateMovieRequest,
    },
    repository,
};

#[derive(Debug)]
pub enum MovieError {
    Invalid,
    NotFound,
    Conflict,
    Validation(Vec<&'static str>),
    MediaDelete,
    MediaDeleteFinalization,
    Database,
}

impl From<DbErr> for MovieError {
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl From<ContentRuleError> for MovieError {
    fn from(error: ContentRuleError) -> Self {
        match error {
            ContentRuleError::Invalid => Self::Invalid,
            ContentRuleError::Conflict => Self::Conflict,
        }
    }
}

impl From<genres::service::GenreError> for MovieError {
    fn from(error: genres::service::GenreError) -> Self {
        match error {
            genres::service::GenreError::Invalid => Self::Invalid,
            genres::service::GenreError::NotFound | genres::service::GenreError::Inactive => {
                Self::Validation(vec!["genres"])
            }
            genres::service::GenreError::Conflict => Self::Conflict,
            genres::service::GenreError::Database => Self::Database,
        }
    }
}

impl IntoResponse for MovieError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid movie request"})),
            )
                .into_response(),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"movie not found"})),
            )
                .into_response(),
            Self::Conflict => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"movie state or version conflict"})),
            )
                .into_response(),
            Self::Validation(fields) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error":"movie validation failed", "fields":fields})),
            )
                .into_response(),
            Self::MediaDelete => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error":"media deletion failed",
                    "code":"media_delete_failed"
                })),
            )
                .into_response(),
            Self::MediaDeleteFinalization => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error":"media deletion finalization failed",
                    "code":"media_delete_finalization_failed"
                })),
            )
                .into_response(),
            Self::Database => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error":"internal server error"})),
            )
                .into_response(),
        }
    }
}

pub async fn create(db: &DatabaseConnection, name: String) -> Result<MovieResponse, MovieError> {
    let name = normalize_required(name)?;
    let model = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await?;
    response(db, model).await
}

pub async fn detail<C: sea_orm::ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> Result<MovieResponse, MovieError> {
    response(db, repository::find(db, id).await?).await
}

pub async fn list(
    db: &DatabaseConnection,
    query: MovieListQuery,
) -> Result<Vec<MovieResponse>, MovieError> {
    let mut select = movie::Entity::find().order_by_desc(movie::Column::CreatedAt);
    if let Some(status) = query.status {
        if !matches!(status.as_str(), "draft" | "published" | "archived") {
            return Err(MovieError::Invalid);
        }
        select = select.filter(movie::Column::Status.eq(status));
    }
    if let Some(name) = query.name {
        let name = name.trim();
        if !name.is_empty() {
            select = select.filter(movie::Column::Name.contains(name));
        }
    }
    let mut result = Vec::new();
    for model in select.all(db).await? {
        result.push(response(db, model).await?);
    }
    Ok(result)
}

pub async fn update(
    db: &DatabaseConnection,
    id: Uuid,
    input: UpdateMovieRequest,
) -> Result<MovieResponse, MovieError> {
    require_positive_i64(input.version)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(model.version, input.version)?;
    if model.status != "draft" {
        return Err(MovieError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;
    apply_optional_i32(&mut model.duration_seconds, input.duration_seconds, true)?;

    let genre_ids = input.genre_ids.map(parse_unique_uuids).transpose()?;
    let existing_genres = repository::genres(&tx, id).await?;
    let existing_ids = existing_genres
        .iter()
        .map(|genre| genre.id)
        .collect::<HashSet<_>>();
    let genre_ids = if let Some(mut requested) = genre_ids {
        let newly_added = requested
            .iter()
            .copied()
            .filter(|id| !existing_ids.contains(id))
            .collect::<Vec<_>>();
        if !newly_added.is_empty() {
            genres::service::ensure_associable(&tx, &newly_added).await?;
        }
        for genre in existing_genres.iter().filter(|genre| !genre.enabled) {
            if !requested.contains(&genre.id) {
                requested.push(genre.id);
            }
        }
        Some(requested)
    } else {
        None
    };
    let updated = repository::persist(&tx, &model, input.version).await?;
    if let Some(ids) = genre_ids {
        repository::replace_genres(&tx, id, &ids).await?;
    }
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<MovieResponse, MovieError> {
    require_positive_i64(expected_version)?;
    let target = parse_target(target)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    if target.matches(&model.status) {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(model.version, expected_version)?;
    ensure_transition(&model.status, target)?;
    if target == TargetState::Published {
        validate_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    apply_target_state(
        &mut model.status,
        &mut model.published_at,
        &mut model.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated = repository::persist(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete_impact(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<DeleteImpactResponse, MovieError> {
    let model = repository::find(db, id).await?;
    let assets = [model.poster_asset_id, model.video_asset_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    Ok(DeleteImpactResponse {
        name: model.name,
        version: model.version,
        season_count: 0,
        episode_count: 0,
        media_count: assets.len() as u64,
    })
}

pub async fn delete(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    id: Uuid,
    expected_version: i64,
) -> Result<DeleteResultResponse, MovieError> {
    require_positive_i64(expected_version)?;
    let guard = storage
        .acquire_removal()
        .await
        .map_err(|_| MovieError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_version(model.version, expected_version)?;
    if model.status == "published" {
        return Err(MovieError::Conflict);
    }
    let assets = [model.poster_asset_id, model.video_asset_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids)
        .await
        .map_err(|_| MovieError::MediaDelete)?;
    let removal = removal::continue_with_guard(storage, guard);
    let staged = match removal.stage("delete-movie", &owned) {
        Ok(staged) => staged,
        Err(_) => {
            let _ = tx.rollback().await;
            return Err(MovieError::MediaDelete);
        }
    };
    let database_result: Result<(), MovieError> = async {
        repository::delete(&tx, id, expected_version).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    match removal::finish_delete_transaction(tx, staged, owned.len(), database_result).await {
        Ok(count) => Ok(DeleteResultResponse {
            deleted_media_count: count,
        }),
        Err(removal::FinishDeleteError::Operation(MovieError::Database)) => {
            Err(MovieError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Operation(error)) => Err(error),
        Err(removal::FinishDeleteError::Restore | removal::FinishDeleteError::Commit) => {
            Err(MovieError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Finalize) => Err(MovieError::MediaDeleteFinalization),
    }
}

async fn response<C: sea_orm::ConnectionTrait>(
    db: &C,
    model: movie::Model,
) -> Result<MovieResponse, MovieError> {
    let genres = repository::genres(db, model.id).await?;
    let poster = repository::asset(db, model.poster_asset_id).await?;
    let video = repository::asset(db, model.video_asset_id).await?;
    Ok(MovieResponse::new(model, genres, poster, video))
}

async fn validate_publish<C: sea_orm::ConnectionTrait>(
    db: &C,
    storage: &MediaStorageSet,
    allowed_video_mime_types: &[String],
    model: &movie::Model,
) -> Result<(), MovieError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    let video = repository::asset(db, model.video_asset_id).await?;
    if !is_publishable_asset(storage, video.as_ref(), "video", allowed_video_mime_types) {
        missing.push("video");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(MovieError::Validation(missing))
    }
}
