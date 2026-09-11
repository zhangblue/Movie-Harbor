use crate::{
    entities::{file_cleanup_job, media_asset, movie},
    genres,
    media::LocalMediaStorage,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set, TransactionTrait, sea_query::OnConflict,
};
use std::collections::HashSet;
use uuid::Uuid;

use super::{
    dto::{MovieListQuery, MovieResponse, Patch, UpdateMovieRequest},
    repository,
};

#[derive(Debug)]
pub enum MovieError {
    Invalid,
    NotFound,
    Conflict,
    Validation(Vec<&'static str>),
    Database,
}

impl From<DbErr> for MovieError {
    fn from(_: DbErr) -> Self {
        Self::Database
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
            Self::Database => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error":"internal server error"})),
            )
                .into_response(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaSlot {
    Poster,
    Video,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TargetState {
    Draft,
    Published,
    Archived,
}

pub async fn create(db: &DatabaseConnection, name: String) -> Result<MovieResponse, MovieError> {
    let name = normalize_name(name)?;
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
    valid_version(input.version)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(&model, input.version)?;
    if model.status != "draft" {
        return Err(MovieError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;
    apply_optional_i32(&mut model.duration_seconds, input.duration_seconds, true)?;

    let genre_ids = input
        .genre_ids
        .map(|ids| parse_ids(ids).map_err(|_| MovieError::Invalid))
        .transpose()?;
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

pub async fn associate_media(
    db: &DatabaseConnection,
    id: Uuid,
    asset_id: Uuid,
    expected_version: i64,
    slot: MediaSlot,
) -> Result<MovieResponse, MovieError> {
    valid_version(expected_version)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(&model, expected_version)?;
    if model.status != "draft" {
        return Err(MovieError::Conflict);
    }
    let asset = media_asset::Entity::find_by_id(asset_id)
        .lock_shared()
        .one(&tx)
        .await?
        .ok_or_else(|| MovieError::Validation(vec![slot.field_name()]))?;
    if asset.purpose != slot.purpose() {
        return Err(MovieError::Validation(vec![slot.field_name()]));
    }
    let old_id = match slot {
        MediaSlot::Poster => model.poster_asset_id.replace(asset_id),
        MediaSlot::Video => model.video_asset_id.replace(asset_id),
    };
    if old_id == Some(asset_id) {
        return response(&tx, model).await;
    }
    let updated = repository::persist(&tx, &model, expected_version).await?;
    if let Some(old_id) = old_id {
        queue_cleanup(&tx, old_id).await?;
    }
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<MovieResponse, MovieError> {
    valid_version(expected_version)?;
    let target = TargetState::parse(target)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    if target.matches(&model.status) {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(&model, expected_version)?;
    ensure_transition(&model.status, target)?;
    if target == TargetState::Published {
        validate_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    let now = Utc::now().fixed_offset();
    match target {
        TargetState::Draft => {
            model.status = "draft".into();
            model.published_at = None;
            model.archived_at = None;
        }
        TargetState::Published => {
            model.status = "published".into();
            if model.published_at.is_none() {
                model.published_at = Some(now);
            }
            model.archived_at = None;
        }
        TargetState::Archived => {
            model.status = "archived".into();
            model.archived_at = Some(now);
        }
    }
    let updated = repository::persist(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete(
    db: &DatabaseConnection,
    id: Uuid,
    expected_version: i64,
) -> Result<(), MovieError> {
    valid_version(expected_version)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_version(&model, expected_version)?;
    if model.status == "published" {
        return Err(MovieError::Conflict);
    }
    let assets = [model.poster_asset_id, model.video_asset_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    repository::delete(&tx, id, expected_version).await?;
    for asset_id in assets {
        queue_cleanup(&tx, asset_id).await?;
    }
    tx.commit().await?;
    Ok(())
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

async fn queue_cleanup<C: sea_orm::ConnectionTrait>(
    db: &C,
    media_asset_id: Uuid,
) -> Result<(), MovieError> {
    file_cleanup_job::Entity::insert(file_cleanup_job::ActiveModel {
        id: Set(Uuid::new_v4()),
        media_asset_id: Set(media_asset_id),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(file_cleanup_job::Column::MediaAssetId)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}

async fn validate_publish<C: sea_orm::ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &movie::Model,
) -> Result<(), MovieError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    let poster = repository::asset(db, model.poster_asset_id).await?;
    if !valid_asset(
        storage,
        poster.as_ref(),
        "poster",
        &["image/jpeg", "image/png", "image/webp"],
    )
    .await
    {
        missing.push("poster");
    }
    let video = repository::asset(db, model.video_asset_id).await?;
    if !valid_asset(storage, video.as_ref(), "video", allowed_video_mime_types).await {
        missing.push("video");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(MovieError::Validation(missing))
    }
}

async fn valid_asset<S: AsRef<str>>(
    storage: &LocalMediaStorage,
    asset: Option<&media_asset::Model>,
    purpose: &str,
    allowed_mime_types: &[S],
) -> bool {
    let Some(asset) = asset else {
        return false;
    };
    asset.purpose == purpose
        && allowed_mime_types
            .iter()
            .any(|mime| mime.as_ref() == asset.mime_type)
        && storage
            .is_accessible_regular_file(&asset.storage_key)
            .await
            .unwrap_or(false)
}

fn normalize_name(name: String) -> Result<String, MovieError> {
    let name = name.trim();
    if name.is_empty() {
        Err(MovieError::Invalid)
    } else {
        Ok(name.to_owned())
    }
}

fn valid_version(version: i64) -> Result<(), MovieError> {
    if version <= 0 {
        Err(MovieError::Invalid)
    } else {
        Ok(())
    }
}

fn require_version(model: &movie::Model, version: i64) -> Result<(), MovieError> {
    if model.version == version {
        Ok(())
    } else {
        Err(MovieError::Conflict)
    }
}

fn parse_ids(ids: Vec<String>) -> Result<Vec<Uuid>, ()> {
    let ids = ids
        .into_iter()
        .map(|id| id.parse().map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    if ids.iter().copied().collect::<HashSet<_>>().len() != ids.len() {
        return Err(());
    }
    Ok(ids)
}

fn apply_text(
    current: &mut String,
    patch: Patch<String>,
    nonblank: bool,
) -> Result<(), MovieError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Null => Err(MovieError::Invalid),
        Patch::Value(value) => {
            let value = value.trim();
            if nonblank && value.is_empty() {
                return Err(MovieError::Invalid);
            }
            *current = value.to_owned();
            Ok(())
        }
    }
}

fn apply_optional_i32(
    current: &mut Option<i32>,
    patch: Patch<i32>,
    nonnegative: bool,
) -> Result<(), MovieError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Null => {
            *current = None;
            Ok(())
        }
        Patch::Value(value) if !nonnegative || value >= 0 => {
            *current = Some(value);
            Ok(())
        }
        Patch::Value(_) => Err(MovieError::Invalid),
    }
}

fn ensure_transition(current: &str, target: TargetState) -> Result<(), MovieError> {
    let allowed = matches!(
        (current, target),
        ("draft", TargetState::Published)
            | ("published", TargetState::Archived)
            | ("archived", TargetState::Published)
            | ("archived", TargetState::Draft)
    );
    if allowed {
        Ok(())
    } else {
        Err(MovieError::Conflict)
    }
}

impl MediaSlot {
    fn purpose(self) -> &'static str {
        match self {
            Self::Poster => "poster",
            Self::Video => "video",
        }
    }

    fn field_name(self) -> &'static str {
        self.purpose()
    }
}

impl TargetState {
    fn parse(value: &str) -> Result<Self, MovieError> {
        match value {
            "draft" => Ok(Self::Draft),
            "published" => Ok(Self::Published),
            "archived" => Ok(Self::Archived),
            _ => Err(MovieError::Invalid),
        }
    }

    fn matches(self, current: &str) -> bool {
        matches!(
            (self, current),
            (Self::Draft, "draft") | (Self::Published, "published") | (Self::Archived, "archived")
        )
    }
}
