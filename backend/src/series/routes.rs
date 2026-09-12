use crate::{
    auth::{self, AuthState},
    media::LocalMediaStorage,
    movies::dto::{DeleteImpactResponse, DeleteResultResponse},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    routing::{get, patch, post},
};
use sea_orm::DatabaseConnection;
use uuid::Uuid;

use super::{
    dto::{
        ChildDeleteImpactResponse, CreateEpisodeRequest, CreateSeasonRequest, CreateSeriesRequest,
        EpisodeEnvelope, SeriesListQuery, SeriesResponse, UpdateEpisodeRequest,
        UpdateSeasonRequest, UpdateSeriesRequest, VersionRequest,
    },
    service::{
        self, CreateEpisodeCommand, CreateSeasonCommand, DeleteEpisodeCommand, DeleteSeasonCommand,
        SeriesError, TransitionEpisodeCommand, UpdateEpisodeCommand, UpdateSeasonCommand,
    },
};

#[derive(Clone)]
struct SeriesState {
    db: DatabaseConnection,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
}

pub fn router(
    auth_state: AuthState,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
) -> Router {
    let state = SeriesState {
        db: auth_state.db.clone(),
        storage,
        allowed_video_mime_types,
    };
    Router::new()
        .route("/api/admin/series", get(list).post(create))
        .route(
            "/api/admin/series/{series_id}",
            get(detail).patch(update).delete(delete_series),
        )
        .route(
            "/api/admin/series/{series_id}/delete-impact",
            get(delete_impact),
        )
        .route(
            "/api/admin/series/{series_id}/publish",
            post(publish_series),
        )
        .route(
            "/api/admin/series/{series_id}/archive",
            post(archive_series),
        )
        .route("/api/admin/series/{series_id}/draft", post(draft_series))
        .route("/api/admin/series/{series_id}/seasons", post(create_season))
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}",
            patch(update_season).delete(delete_season),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/delete-impact",
            get(season_delete_impact),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes",
            post(create_episode),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}",
            get(episode_detail)
                .patch(update_episode)
                .delete(delete_episode),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/delete-impact",
            get(episode_delete_impact),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish",
            post(publish_episode),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/archive",
            post(archive_episode),
        )
        .route(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/draft",
            post(draft_episode),
        )
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        .with_state(state)
}

async fn list(
    State(state): State<SeriesState>,
    Query(query): Query<SeriesListQuery>,
) -> Result<Json<Vec<SeriesResponse>>, SeriesError> {
    Ok(Json(service::list(&state.db, query).await?))
}
async fn create(
    State(state): State<SeriesState>,
    Json(input): Json<CreateSeriesRequest>,
) -> Result<(StatusCode, Json<SeriesResponse>), SeriesError> {
    Ok((
        StatusCode::CREATED,
        Json(service::create(&state.db, input.name).await?),
    ))
}

async fn detail(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    Ok(Json(
        service::detail(&state.db, parse_id(series_id)?).await?,
    ))
}

async fn update(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<UpdateSeriesRequest>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    Ok(Json(
        service::update(&state.db, parse_id(series_id)?, input).await?,
    ))
}

async fn create_season(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<CreateSeasonRequest>,
) -> Result<(StatusCode, Json<SeriesResponse>), SeriesError> {
    Ok((
        StatusCode::CREATED,
        Json(
            service::create_season(
                &state.db,
                CreateSeasonCommand {
                    series_id: parse_id(series_id)?,
                    expected_series_version: input.version,
                    number: input.number,
                },
            )
            .await?,
        ),
    ))
}

async fn update_season(
    State(state): State<SeriesState>,
    Path((series_id, season_id)): Path<(String, String)>,
    Json(input): Json<UpdateSeasonRequest>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    Ok(Json(
        service::update_season(
            &state.db,
            UpdateSeasonCommand {
                series_id: parse_id(series_id)?,
                season_id: parse_id(season_id)?,
                expected_series_version: input.version,
                number: input.number,
            },
        )
        .await?,
    ))
}

async fn delete_season(
    State(state): State<SeriesState>,
    Path((series_id, season_id)): Path<(String, String)>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<DeleteResultResponse>, SeriesError> {
    Ok(Json(
        service::delete_season(
            &state.db,
            &state.storage,
            DeleteSeasonCommand {
                series_id: parse_id(series_id)?,
                season_id: parse_id(season_id)?,
                expected_series_version: input.version,
            },
        )
        .await?,
    ))
}

async fn season_delete_impact(
    State(state): State<SeriesState>,
    Path((series_id, season_id)): Path<(String, String)>,
) -> Result<Json<ChildDeleteImpactResponse>, SeriesError> {
    Ok(Json(
        service::season_delete_impact(&state.db, parse_id(series_id)?, parse_id(season_id)?)
            .await?,
    ))
}

async fn create_episode(
    State(state): State<SeriesState>,
    Path((series_id, season_id)): Path<(String, String)>,
    Json(input): Json<CreateEpisodeRequest>,
) -> Result<(StatusCode, Json<SeriesResponse>), SeriesError> {
    Ok((
        StatusCode::CREATED,
        Json(
            service::create_episode(
                &state.db,
                CreateEpisodeCommand {
                    series_id: parse_id(series_id)?,
                    season_id: parse_id(season_id)?,
                    input,
                },
            )
            .await?,
        ),
    ))
}

async fn episode_detail(
    State(state): State<SeriesState>,
    Path((series_id, season_id, episode_id)): Path<(String, String, String)>,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    Ok(Json(
        service::episode_detail(
            &state.db,
            parse_id(series_id)?,
            parse_id(season_id)?,
            parse_id(episode_id)?,
        )
        .await?,
    ))
}

async fn update_episode(
    State(state): State<SeriesState>,
    Path((series_id, season_id, episode_id)): Path<(String, String, String)>,
    Json(input): Json<UpdateEpisodeRequest>,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    Ok(Json(
        service::update_episode(
            &state.db,
            UpdateEpisodeCommand {
                series_id: parse_id(series_id)?,
                season_id: parse_id(season_id)?,
                episode_id: parse_id(episode_id)?,
                input,
            },
        )
        .await?,
    ))
}

async fn publish_series(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    transition_series(state, series_id, input, "published").await
}

async fn archive_series(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    transition_series(state, series_id, input, "archived").await
}

async fn draft_series(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<SeriesResponse>, SeriesError> {
    transition_series(state, series_id, input, "draft").await
}

async fn transition_series(
    state: SeriesState,
    series_id: String,
    input: VersionRequest,
    target: &str,
) -> Result<Json<SeriesResponse>, SeriesError> {
    Ok(Json(
        service::transition_series(
            &state.db,
            &state.storage,
            &state.allowed_video_mime_types,
            parse_id(series_id)?,
            input.version,
            target,
        )
        .await?,
    ))
}

async fn publish_episode(
    State(state): State<SeriesState>,
    Path(ids): Path<(String, String, String)>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    transition_episode(state, ids, input, "published").await
}

async fn archive_episode(
    State(state): State<SeriesState>,
    Path(ids): Path<(String, String, String)>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    transition_episode(state, ids, input, "archived").await
}

async fn draft_episode(
    State(state): State<SeriesState>,
    Path(ids): Path<(String, String, String)>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    transition_episode(state, ids, input, "draft").await
}

async fn transition_episode(
    state: SeriesState,
    ids: (String, String, String),
    input: VersionRequest,
    target: &str,
) -> Result<Json<EpisodeEnvelope>, SeriesError> {
    Ok(Json(
        service::transition_episode(
            &state.db,
            &state.storage,
            &state.allowed_video_mime_types,
            TransitionEpisodeCommand {
                series_id: parse_id(ids.0)?,
                season_id: parse_id(ids.1)?,
                episode_id: parse_id(ids.2)?,
                expected_episode_version: input.version,
                target,
            },
        )
        .await?,
    ))
}

async fn delete_episode(
    State(state): State<SeriesState>,
    Path((series_id, season_id, episode_id)): Path<(String, String, String)>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<DeleteResultResponse>, SeriesError> {
    let result = service::delete_episode(
        &state.db,
        &state.storage,
        DeleteEpisodeCommand {
            series_id: parse_id(series_id)?,
            season_id: parse_id(season_id)?,
            episode_id: parse_id(episode_id)?,
            expected_episode_version: input.version,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn episode_delete_impact(
    State(state): State<SeriesState>,
    Path((series_id, season_id, episode_id)): Path<(String, String, String)>,
) -> Result<Json<ChildDeleteImpactResponse>, SeriesError> {
    Ok(Json(
        service::episode_delete_impact(
            &state.db,
            parse_id(series_id)?,
            parse_id(season_id)?,
            parse_id(episode_id)?,
        )
        .await?,
    ))
}

async fn delete_series(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<DeleteResultResponse>, SeriesError> {
    Ok(Json(
        service::delete_series(
            &state.db,
            &state.storage,
            parse_id(series_id)?,
            input.version,
        )
        .await?,
    ))
}

async fn delete_impact(
    State(state): State<SeriesState>,
    Path(series_id): Path<String>,
) -> Result<Json<DeleteImpactResponse>, SeriesError> {
    Ok(Json(
        service::delete_impact(&state.db, parse_id(series_id)?).await?,
    ))
}

fn parse_id(value: String) -> Result<Uuid, SeriesError> {
    value.parse().map_err(|_| SeriesError::Invalid)
}
