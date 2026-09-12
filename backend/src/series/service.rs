use crate::{
    entities::{episode, season, series},
    genres,
    media::{
        LocalMediaStorage, cleanup, is_publishable_asset,
        references::{lock_for_reference_removal, queue_locked_if_unreferenced, reference_count},
    },
    movies::dto::{DeleteImpactResponse, DeleteResultResponse, Patch},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr,
    EntityTrait, IsolationLevel, QueryFilter, QueryOrder, QuerySelect, Set, SqlErr,
    TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use super::{
    dto::{
        ChildDeleteImpactResponse, CreateEpisodeRequest, EpisodeEnvelope, EpisodeResponse,
        SeasonResponse, SeriesListQuery, SeriesResponse, UpdateEpisodeRequest, UpdateSeriesRequest,
    },
    repository,
};

#[derive(Debug)]
pub enum SeriesError {
    Invalid,
    NotFound,
    Conflict,
    Validation(Vec<&'static str>),
    Database,
}

impl From<DbErr> for SeriesError {
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl From<genres::service::GenreError> for SeriesError {
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

impl IntoResponse for SeriesError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid series request"})),
            )
                .into_response(),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"series hierarchy not found"})),
            )
                .into_response(),
            Self::Conflict => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"series state, hierarchy, or version conflict"})),
            )
                .into_response(),
            Self::Validation(fields) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error":"series validation failed", "fields":fields})),
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
enum TargetState {
    Draft,
    Published,
    Archived,
}

pub struct CreateSeasonCommand {
    pub series_id: Uuid,
    pub expected_series_version: i64,
    pub number: i32,
}

pub struct UpdateSeasonCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub expected_series_version: i64,
    pub number: i32,
}

pub struct DeleteSeasonCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub expected_series_version: i64,
}

pub struct CreateEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub input: CreateEpisodeRequest,
}

pub struct UpdateEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub input: UpdateEpisodeRequest,
}

pub struct TransitionEpisodeCommand<'a> {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub expected_episode_version: i64,
    pub target: &'a str,
}

pub struct DeleteEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub expected_episode_version: i64,
}

pub async fn create(db: &DatabaseConnection, name: String) -> Result<SeriesResponse, SeriesError> {
    let name = normalize_name(name)?;
    let model = series::ActiveModel {
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

pub async fn detail<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<SeriesResponse, SeriesError> {
    response(db, repository::find(db, id).await?).await
}

pub async fn list(
    db: &DatabaseConnection,
    query: SeriesListQuery,
) -> Result<Vec<SeriesResponse>, SeriesError> {
    let mut select = series::Entity::find().order_by_desc(series::Column::CreatedAt);
    if let Some(status) = query.status {
        if !matches!(status.as_str(), "draft" | "published" | "archived") {
            return Err(SeriesError::Invalid);
        }
        select = select.filter(series::Column::Status.eq(status));
    }
    if let Some(name) = query.name {
        let name = name.trim();
        if !name.is_empty() {
            select = select.filter(series::Column::Name.contains(name));
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
    input: UpdateSeriesRequest,
) -> Result<SeriesResponse, SeriesError> {
    valid_version(input.version)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_series_version(&model, input.version)?;
    if model.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;

    let genre_ids = input
        .genre_ids
        .map(|ids| parse_ids(ids).map_err(|_| SeriesError::Invalid))
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
    let updated = repository::persist_series(&tx, &model, input.version).await?;
    if let Some(ids) = genre_ids {
        repository::replace_genres(&tx, id, &ids).await?;
    }
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn create_season(
    db: &DatabaseConnection,
    command: CreateSeasonCommand,
) -> Result<SeriesResponse, SeriesError> {
    let CreateSeasonCommand {
        series_id,
        expected_series_version: expected_version,
        number,
    } = command;
    valid_version(expected_version)?;
    valid_number(number)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_series_version(&model, expected_version)?;
    season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series_id),
        number: Set(number),
    }
    .insert(&tx)
    .await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn update_season(
    db: &DatabaseConnection,
    command: UpdateSeasonCommand,
) -> Result<SeriesResponse, SeriesError> {
    let UpdateSeasonCommand {
        series_id,
        season_id,
        expected_series_version: expected_version,
        number,
    } = command;
    valid_version(expected_version)?;
    valid_number(number)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_series_version(&model, expected_version)?;
    let current = repository::season_locked(&tx, series_id, season_id).await?;
    if current.number == number {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    if repository::episodes_locked(&tx, season_id)
        .await?
        .iter()
        .any(|episode| episode.status == "published")
    {
        return Err(SeriesError::Conflict);
    }
    let mut active: season::ActiveModel = current.into();
    active.number = Set(number);
    active.update(&tx).await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete_season(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    command: DeleteSeasonCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteSeasonCommand {
        series_id,
        season_id,
        expected_series_version: expected_version,
    } = command;
    valid_version(expected_version)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_series_version(&model, expected_version)?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episodes = repository::episodes_locked(&tx, season_id).await?;
    if episodes.iter().any(|episode| episode.status == "published") {
        return Err(SeriesError::Conflict);
    }
    let assets = episodes
        .into_iter()
        .filter_map(|episode| episode.video_asset_id)
        .collect::<HashSet<_>>();
    let locked_assets = lock_for_reference_removal(&tx, assets).await?;
    season::Entity::delete_by_id(season_id).exec(&tx).await?;
    repository::bump_series(&tx, &model).await?;
    let queued_assets = queue_locked_if_unreferenced(&tx, &locked_assets).await?;
    tx.commit().await?;
    cleanup_result(db, storage, queued_assets).await
}

pub async fn create_episode(
    db: &DatabaseConnection,
    command: CreateEpisodeCommand,
) -> Result<SeriesResponse, SeriesError> {
    let CreateEpisodeCommand {
        series_id,
        season_id,
        input,
    } = command;
    valid_version(input.version)?;
    valid_number(input.number)?;
    let name = normalize_name(input.name)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_series_version(&model, input.version)?;
    repository::season_locked(&tx, series_id, season_id).await?;
    episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season_id),
        number: Set(input.number),
        name: Set(name),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn episode_detail(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<EpisodeEnvelope, SeriesError> {
    let series = repository::find(db, series_id).await?;
    let season = season::Entity::find()
        .filter(season::Column::Id.eq(season_id))
        .filter(season::Column::SeriesId.eq(series_id))
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let episode = episode::Entity::find()
        .filter(episode::Column::Id.eq(episode_id))
        .filter(episode::Column::SeasonId.eq(season.id))
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)?;
    episode_envelope(db, series.version, episode).await
}

pub async fn update_episode(
    db: &DatabaseConnection,
    command: UpdateEpisodeCommand,
) -> Result<EpisodeEnvelope, SeriesError> {
    let UpdateEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        input,
    } = command;
    valid_version(input.version)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_episode_version(&episode, input.version)?;
    if episode.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_required_number(&mut episode.number, input.number)?;
    apply_text(&mut episode.name, input.name, true)?;
    apply_text(&mut episode.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut episode.duration_seconds, input.duration_seconds, true)?;
    let updated_episode = repository::persist_episode(&tx, &episode, input.version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition_series(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<SeriesResponse, SeriesError> {
    valid_version(expected_version)?;
    let target = TargetState::parse(target)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    if target.matches(&model.status) {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_series_version(&model, expected_version)?;
    ensure_transition(&model.status, target)?;
    if target == TargetState::Published {
        validate_series_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    apply_target_state(
        &mut model.status,
        &mut model.published_at,
        &mut model.archived_at,
        target,
    );
    let updated = repository::persist_series(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition_episode(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    command: TransitionEpisodeCommand<'_>,
) -> Result<EpisodeEnvelope, SeriesError> {
    let TransitionEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        expected_episode_version: expected_version,
        target,
    } = command;
    valid_version(expected_version)?;
    let target = TargetState::parse(target)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    if target.matches(&episode.status) {
        let result = episode_envelope(&tx, series.version, episode).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_episode_version(&episode, expected_version)?;
    ensure_transition(&episode.status, target)?;
    if target == TargetState::Published {
        validate_episode_publish(&tx, storage, allowed_video_mime_types, &episode).await?;
    }
    apply_target_state(
        &mut episode.status,
        &mut episode.published_at,
        &mut episode.archived_at,
        target,
    );
    let updated_episode = repository::persist_episode(&tx, &episode, expected_version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete_episode(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    command: DeleteEpisodeCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        expected_episode_version: expected_version,
    } = command;
    valid_version(expected_version)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_episode_version(&episode, expected_version)?;
    if episode.status == "published" {
        return Err(SeriesError::Conflict);
    }
    let locked_assets = lock_for_reference_removal(&tx, episode.video_asset_id).await?;
    repository::delete_episode(&tx, episode_id, expected_version).await?;
    repository::bump_series(&tx, &series).await?;
    let queued_assets = queue_locked_if_unreferenced(&tx, &locked_assets).await?;
    tx.commit().await?;
    cleanup_result(db, storage, queued_assets).await
}

pub async fn delete_series(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    id: Uuid,
    expected_version: i64,
) -> Result<DeleteResultResponse, SeriesError> {
    valid_version(expected_version)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_series_version(&model, expected_version)?;
    if model.status == "published" {
        return Err(SeriesError::Conflict);
    }

    // All hierarchy writers lock series -> season -> episode. Lock children in UUID order before
    // cascading so deletes use that same global order and cannot race a child state transition.
    let seasons = season::Entity::find()
        .filter(season::Column::SeriesId.eq(id))
        .order_by_asc(season::Column::Id)
        .lock_exclusive()
        .all(&tx)
        .await?;
    let mut assets = model.poster_asset_id.into_iter().collect::<HashSet<_>>();
    for season in seasons {
        let episodes = repository::episodes_locked(&tx, season.id).await?;
        assets.extend(
            episodes
                .into_iter()
                .filter_map(|episode| episode.video_asset_id),
        );
    }
    let locked_assets = lock_for_reference_removal(&tx, assets).await?;
    repository::delete_series(&tx, id, expected_version).await?;
    let queued_assets = queue_locked_if_unreferenced(&tx, &locked_assets).await?;
    tx.commit().await?;
    cleanup_result(db, storage, queued_assets).await
}

async fn cleanup_result(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    queued_assets: Vec<Uuid>,
) -> Result<DeleteResultResponse, SeriesError> {
    let job_count = queued_assets.len();
    let cleanup = cleanup::run_for_assets(db, storage, &queued_assets).await;
    let cleanup_pending = match cleanup {
        Ok(outcome) => outcome.failed > 0,
        Err(_) => job_count > 0,
    };
    Ok(DeleteResultResponse {
        cleanup_pending,
        job_count,
        warning: cleanup_pending.then_some("media cleanup pending retry"),
    })
}

pub async fn delete_impact(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<DeleteImpactResponse, SeriesError> {
    let model = repository::find(db, id).await?;
    let seasons = repository::seasons(db, id).await?;
    let mut episode_count = 0_u64;
    let mut references = HashMap::<Uuid, u64>::new();
    if let Some(asset_id) = model.poster_asset_id {
        *references.entry(asset_id).or_default() += 1;
    }
    for season in &seasons {
        for episode in repository::episodes(db, season.id).await? {
            episode_count += 1;
            if let Some(asset_id) = episode.video_asset_id {
                *references.entry(asset_id).or_default() += 1;
            }
        }
    }
    let mut exclusive_media_count = 0;
    let mut shared_media_count = 0;
    for (asset_id, within) in references {
        if reference_count(db, asset_id).await? > within {
            shared_media_count += 1;
        } else {
            exclusive_media_count += 1;
        }
    }
    Ok(DeleteImpactResponse {
        name: model.name,
        version: model.version,
        season_count: seasons.len() as u64,
        episode_count,
        exclusive_media_count,
        shared_media_count,
    })
}

pub async fn season_delete_impact(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
) -> Result<ChildDeleteImpactResponse, SeriesError> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let parent = repository::find(&tx, series_id).await?;
    let selected = season::Entity::find_by_id(season_id)
        .filter(season::Column::SeriesId.eq(series_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let episodes = repository::episodes(&tx, season_id).await?;
    let mut references = HashMap::new();
    for asset_id in episodes.iter().filter_map(|episode| episode.video_asset_id) {
        *references.entry(asset_id).or_insert(0_u64) += 1;
    }
    let (exclusive_media_count, shared_media_count) = impact_media_counts(&tx, references).await?;
    let result = ChildDeleteImpactResponse {
        display_name: format!("第 {} 季", selected.number),
        version: parent.version,
        season_count: 1,
        episode_count: episodes.len() as u64,
        exclusive_media_count,
        shared_media_count,
    };
    tx.commit().await?;
    Ok(result)
}

pub async fn episode_delete_impact(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<ChildDeleteImpactResponse, SeriesError> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    repository::find(&tx, series_id).await?;
    season::Entity::find_by_id(season_id)
        .filter(season::Column::SeriesId.eq(series_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let selected = episode::Entity::find_by_id(episode_id)
        .filter(episode::Column::SeasonId.eq(season_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let references = selected
        .video_asset_id
        .into_iter()
        .map(|id| (id, 1))
        .collect();
    let (exclusive_media_count, shared_media_count) = impact_media_counts(&tx, references).await?;
    let result = ChildDeleteImpactResponse {
        display_name: selected.name,
        version: selected.version,
        season_count: 0,
        episode_count: 1,
        exclusive_media_count,
        shared_media_count,
    };
    tx.commit().await?;
    Ok(result)
}

async fn impact_media_counts<C: ConnectionTrait>(
    db: &C,
    assets: HashMap<Uuid, u64>,
) -> Result<(u64, u64), SeriesError> {
    let mut exclusive = 0;
    let mut shared = 0;
    for (asset_id, within) in assets {
        if reference_count(db, asset_id).await? > within {
            shared += 1;
        } else {
            exclusive += 1;
        }
    }
    Ok((exclusive, shared))
}

async fn response<C: ConnectionTrait>(
    db: &C,
    model: series::Model,
) -> Result<SeriesResponse, SeriesError> {
    let genres = repository::genres(db, model.id).await?;
    let poster = repository::asset(db, model.poster_asset_id).await?;
    let mut season_responses = Vec::new();
    for season in repository::seasons(db, model.id).await? {
        let mut episode_responses = Vec::new();
        for episode in repository::episodes(db, season.id).await? {
            let video = repository::asset(db, episode.video_asset_id).await?;
            episode_responses.push(EpisodeResponse::new(episode, video));
        }
        season_responses.push(SeasonResponse::new(season, episode_responses));
    }
    Ok(SeriesResponse::new(model, genres, poster, season_responses))
}

async fn episode_envelope<C: ConnectionTrait>(
    db: &C,
    series_version: i64,
    episode: episode::Model,
) -> Result<EpisodeEnvelope, SeriesError> {
    let video = repository::asset(db, episode.video_asset_id).await?;
    Ok(EpisodeEnvelope {
        series_version,
        episode: EpisodeResponse::new(episode, video),
    })
}

async fn validate_series_publish<C: ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &series::Model,
) -> Result<(), SeriesError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    let poster = repository::asset(db, model.poster_asset_id).await?;
    if !is_publishable_asset(
        storage,
        poster.as_ref(),
        "poster",
        &["image/jpeg", "image/png", "image/webp"],
    ) {
        missing.push("poster");
    }
    let mut publishable_episode = false;
    for season in repository::seasons(db, model.id).await? {
        for episode in repository::episodes(db, season.id).await? {
            if episode.status != "published" {
                continue;
            }
            let video = repository::asset(db, episode.video_asset_id).await?;
            if is_publishable_asset(storage, video.as_ref(), "video", allowed_video_mime_types) {
                publishable_episode = true;
                break;
            }
        }
        if publishable_episode {
            break;
        }
    }
    if !publishable_episode {
        missing.push("episodes");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(SeriesError::Validation(missing))
    }
}

async fn validate_episode_publish<C: ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &episode::Model,
) -> Result<(), SeriesError> {
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
        Err(SeriesError::Validation(missing))
    }
}

fn normalize_name(name: String) -> Result<String, SeriesError> {
    let name = name.trim();
    if name.is_empty() {
        Err(SeriesError::Invalid)
    } else {
        Ok(name.to_owned())
    }
}

fn valid_version(version: i64) -> Result<(), SeriesError> {
    if version <= 0 {
        Err(SeriesError::Invalid)
    } else {
        Ok(())
    }
}

fn valid_number(number: i32) -> Result<(), SeriesError> {
    if number <= 0 {
        Err(SeriesError::Invalid)
    } else {
        Ok(())
    }
}

fn require_series_version(model: &series::Model, version: i64) -> Result<(), SeriesError> {
    if model.version == version {
        Ok(())
    } else {
        Err(SeriesError::Conflict)
    }
}

fn require_episode_version(model: &episode::Model, version: i64) -> Result<(), SeriesError> {
    if model.version == version {
        Ok(())
    } else {
        Err(SeriesError::Conflict)
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
) -> Result<(), SeriesError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Null => Err(SeriesError::Invalid),
        Patch::Value(value) => {
            let value = value.trim();
            if nonblank && value.is_empty() {
                return Err(SeriesError::Invalid);
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
) -> Result<(), SeriesError> {
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
        Patch::Value(_) => Err(SeriesError::Invalid),
    }
}

fn apply_required_number(current: &mut i32, patch: Patch<i32>) -> Result<(), SeriesError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Value(value) if value > 0 => {
            *current = value;
            Ok(())
        }
        Patch::Null | Patch::Value(_) => Err(SeriesError::Invalid),
    }
}

fn ensure_transition(current: &str, target: TargetState) -> Result<(), SeriesError> {
    if matches!(
        (current, target),
        ("draft", TargetState::Published)
            | ("published", TargetState::Archived)
            | ("archived", TargetState::Published)
            | ("archived", TargetState::Draft)
    ) {
        Ok(())
    } else {
        Err(SeriesError::Conflict)
    }
}

fn apply_target_state(
    status: &mut String,
    published_at: &mut Option<chrono::DateTime<chrono::FixedOffset>>,
    archived_at: &mut Option<chrono::DateTime<chrono::FixedOffset>>,
    target: TargetState,
) {
    let now = Utc::now().fixed_offset();
    match target {
        TargetState::Draft => {
            *status = "draft".into();
            *published_at = None;
            *archived_at = None;
        }
        TargetState::Published => {
            *status = "published".into();
            if published_at.is_none() {
                *published_at = Some(now);
            }
            *archived_at = None;
        }
        TargetState::Archived => {
            *status = "archived".into();
            *archived_at = Some(now);
        }
    }
}

impl TargetState {
    fn parse(value: &str) -> Result<Self, SeriesError> {
        match value {
            "draft" => Ok(Self::Draft),
            "published" => Ok(Self::Published),
            "archived" => Ok(Self::Archived),
            _ => Err(SeriesError::Invalid),
        }
    }

    fn matches(self, current: &str) -> bool {
        matches!(
            (self, current),
            (Self::Draft, "draft") | (Self::Published, "published") | (Self::Archived, "archived")
        )
    }
}
