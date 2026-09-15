use crate::{
    content::{
        ContentRuleError, Patch, TargetState, apply_optional_i32, apply_target_state, apply_text,
        ensure_transition, normalize_required, parse_target, parse_unique_uuids,
        require_positive_i32, require_positive_i64, require_version,
    },
    entities::{episode, season, series},
    genres,
    media::{MediaStorageSet, is_publishable_asset, removal},
    movies::dto::{DeleteImpactResponse, DeleteResultResponse},
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
use std::collections::HashSet;
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
    MediaDelete,
    MediaDeleteFinalization,
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

impl From<ContentRuleError> for SeriesError {
    fn from(error: ContentRuleError) -> Self {
        match error {
            ContentRuleError::Invalid => Self::Invalid,
            ContentRuleError::Conflict => Self::Conflict,
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
    let name = normalize_required(name)?;
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
    require_positive_i64(input.version)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(model.version, input.version)?;
    if model.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;

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
    require_positive_i64(expected_version)?;
    require_positive_i32(number)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
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
    require_positive_i64(expected_version)?;
    require_positive_i32(number)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
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
    storage: &MediaStorageSet,
    command: DeleteSeasonCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteSeasonCommand {
        series_id,
        season_id,
        expected_series_version: expected_version,
    } = command;
    require_positive_i64(expected_version)?;
    let guard = storage
        .lock_removal()
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episodes = repository::episodes_locked(&tx, season_id).await?;
    if episodes.iter().any(|episode| episode.status == "published") {
        return Err(SeriesError::Conflict);
    }
    let assets = episodes
        .into_iter()
        .filter_map(|episode| episode.video_asset_id)
        .collect::<HashSet<_>>();
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let removal = removal::continue_with_guard(
        storage.volume(0).ok_or(SeriesError::MediaDelete)?.storage(),
        guard,
    );
    let staged = removal
        .stage("delete-season", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    let database_result: Result<(), SeriesError> = async {
        season::Entity::delete_by_id(season_id).exec(&tx).await?;
        repository::bump_series(&tx, &model).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
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
    require_positive_i64(input.version)?;
    require_positive_i32(input.number)?;
    let name = normalize_required(input.name)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, input.version)?;
    repository::season_locked(&tx, series_id, season_id).await?;
    episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season_id),
        number: Set(input.number),
        name: Set(name),
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
    require_positive_i64(input.version)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_version(episode.version, input.version)?;
    if episode.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_required_number(&mut episode.number, input.number)?;
    apply_text(&mut episode.name, input.name, true)?;
    apply_optional_i32(&mut episode.duration_seconds, input.duration_seconds, true)?;
    let updated_episode = repository::persist_episode(&tx, &episode, input.version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition_series(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<SeriesResponse, SeriesError> {
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
        validate_series_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    apply_target_state(
        &mut model.status,
        &mut model.published_at,
        &mut model.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated = repository::persist_series(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn transition_episode(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
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
    require_positive_i64(expected_version)?;
    let target = parse_target(target)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    if target.matches(&episode.status) {
        let result = episode_envelope(&tx, series.version, episode).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(episode.version, expected_version)?;
    ensure_transition(&episode.status, target)?;
    if target == TargetState::Published {
        validate_episode_publish(&tx, storage, allowed_video_mime_types, &episode).await?;
    }
    apply_target_state(
        &mut episode.status,
        &mut episode.published_at,
        &mut episode.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated_episode = repository::persist_episode(&tx, &episode, expected_version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete_episode(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    command: DeleteEpisodeCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        expected_episode_version: expected_version,
    } = command;
    require_positive_i64(expected_version)?;
    let guard = storage
        .lock_removal()
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_version(episode.version, expected_version)?;
    if episode.status == "published" {
        return Err(SeriesError::Conflict);
    }
    let asset_ids = episode.video_asset_id.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let removal = removal::continue_with_guard(
        storage.volume(0).ok_or(SeriesError::MediaDelete)?.storage(),
        guard,
    );
    let staged = removal
        .stage("delete-episode", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    let database_result: Result<(), SeriesError> = async {
        repository::delete_episode(&tx, episode_id, expected_version).await?;
        repository::bump_series(&tx, &series).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
}

pub async fn delete_series(
    db: &DatabaseConnection,
    storage: &MediaStorageSet,
    id: Uuid,
    expected_version: i64,
) -> Result<DeleteResultResponse, SeriesError> {
    require_positive_i64(expected_version)?;
    let guard = storage
        .lock_removal()
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_version(model.version, expected_version)?;
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
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let removal = removal::continue_with_guard(
        storage.volume(0).ok_or(SeriesError::MediaDelete)?.storage(),
        guard,
    );
    let staged = removal
        .stage("delete-series", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    let database_result: Result<(), SeriesError> = async {
        repository::delete_series(&tx, id, expected_version).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
}

async fn finish_delete_transaction(
    tx: sea_orm::DatabaseTransaction,
    staged: removal::StagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), SeriesError>,
) -> Result<DeleteResultResponse, SeriesError> {
    match removal::finish_delete_transaction(tx, staged, deleted_media_count, database_result).await
    {
        Ok(count) => Ok(DeleteResultResponse {
            deleted_media_count: count,
        }),
        Err(removal::FinishDeleteError::Operation(SeriesError::Database)) => {
            Err(SeriesError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Operation(error)) => Err(error),
        Err(removal::FinishDeleteError::Restore | removal::FinishDeleteError::Commit) => {
            Err(SeriesError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Finalize) => Err(SeriesError::MediaDeleteFinalization),
    }
}

pub async fn delete_impact(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<DeleteImpactResponse, SeriesError> {
    let model = repository::find(db, id).await?;
    let seasons = repository::seasons(db, id).await?;
    let mut episode_count = 0_u64;
    let mut assets = HashSet::new();
    if let Some(asset_id) = model.poster_asset_id {
        assets.insert(asset_id);
    }
    for season in &seasons {
        for episode in repository::episodes(db, season.id).await? {
            episode_count += 1;
            if let Some(asset_id) = episode.video_asset_id {
                assets.insert(asset_id);
            }
        }
    }
    Ok(DeleteImpactResponse {
        name: model.name,
        version: model.version,
        season_count: seasons.len() as u64,
        episode_count,
        media_count: assets.len() as u64,
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
    let mut assets = HashSet::new();
    for asset_id in episodes.iter().filter_map(|episode| episode.video_asset_id) {
        assets.insert(asset_id);
    }
    let result = ChildDeleteImpactResponse {
        display_name: format!("第 {} 季", selected.number),
        version: parent.version,
        season_count: 1,
        episode_count: episodes.len() as u64,
        media_count: assets.len() as u64,
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
    let result = ChildDeleteImpactResponse {
        display_name: selected.name,
        version: selected.version,
        season_count: 0,
        episode_count: 1,
        media_count: u64::from(selected.video_asset_id.is_some()),
    };
    tx.commit().await?;
    Ok(result)
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
    storage: &MediaStorageSet,
    allowed_video_mime_types: &[String],
    model: &series::Model,
) -> Result<(), SeriesError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
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
    storage: &MediaStorageSet,
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

fn apply_required_number(current: &mut i32, patch: Patch<i32>) -> Result<(), SeriesError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Value(value) => {
            require_positive_i32(value)?;
            *current = value;
            Ok(())
        }
        Patch::Null => Err(SeriesError::Invalid),
    }
}
