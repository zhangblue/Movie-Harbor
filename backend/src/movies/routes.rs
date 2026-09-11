use crate::{
    auth::{self, AuthState},
    media::LocalMediaStorage,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    routing::{get, post, put},
};
use sea_orm::DatabaseConnection;
use uuid::Uuid;

use super::{
    dto::{
        AssociateMediaRequest, CreateMovieRequest, MovieListQuery, MovieResponse,
        UpdateMovieRequest, VersionRequest,
    },
    service::{self, MediaSlot, MovieError},
};

#[derive(Clone)]
struct MovieState {
    db: DatabaseConnection,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
}

pub fn router(
    auth_state: AuthState,
    storage: LocalMediaStorage,
    allowed_video_mime_types: Vec<String>,
) -> Router {
    let state = MovieState {
        db: auth_state.db.clone(),
        storage,
        allowed_video_mime_types,
    };
    Router::new()
        .route("/api/admin/movies", get(list).post(create))
        .route(
            "/api/admin/movies/{id}",
            get(detail).patch(update).delete(delete_movie),
        )
        .route("/api/admin/movies/{id}/poster", put(poster))
        .route("/api/admin/movies/{id}/video", put(video))
        .route("/api/admin/movies/{id}/publish", post(publish))
        .route("/api/admin/movies/{id}/archive", post(archive))
        .route("/api/admin/movies/{id}/draft", post(revert_to_draft))
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        .with_state(state)
}

async fn list(
    State(state): State<MovieState>,
    Query(query): Query<MovieListQuery>,
) -> Result<Json<Vec<MovieResponse>>, MovieError> {
    Ok(Json(service::list(&state.db, query).await?))
}

async fn create(
    State(state): State<MovieState>,
    Json(input): Json<CreateMovieRequest>,
) -> Result<(StatusCode, Json<MovieResponse>), MovieError> {
    Ok((
        StatusCode::CREATED,
        Json(service::create(&state.db, input.name).await?),
    ))
}

async fn detail(
    State(state): State<MovieState>,
    Path(id): Path<String>,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(service::detail(&state.db, parse_id(id)?).await?))
}

async fn update(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateMovieRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::update(&state.db, parse_id(id)?, input).await?,
    ))
}

async fn poster(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<AssociateMediaRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    associate(state, id, input, MediaSlot::Poster).await
}

async fn video(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<AssociateMediaRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    associate(state, id, input, MediaSlot::Video).await
}

async fn associate(
    state: MovieState,
    id: String,
    input: AssociateMediaRequest,
    slot: MediaSlot,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::associate_media(
            &state.db,
            parse_id(id)?,
            parse_id(input.asset_id)?,
            input.version,
            slot,
        )
        .await?,
    ))
}

async fn publish(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "published").await
}

async fn archive(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "archived").await
}

async fn revert_to_draft(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<Json<MovieResponse>, MovieError> {
    transition(state, id, input, "draft").await
}

async fn transition(
    state: MovieState,
    id: String,
    input: VersionRequest,
    target: &str,
) -> Result<Json<MovieResponse>, MovieError> {
    Ok(Json(
        service::transition(
            &state.db,
            &state.storage,
            &state.allowed_video_mime_types,
            parse_id(id)?,
            input.version,
            target,
        )
        .await?,
    ))
}

async fn delete_movie(
    State(state): State<MovieState>,
    Path(id): Path<String>,
    Json(input): Json<VersionRequest>,
) -> Result<StatusCode, MovieError> {
    service::delete(&state.db, parse_id(id)?, input.version).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_id(value: String) -> Result<Uuid, MovieError> {
    value.parse().map_err(|_| MovieError::Invalid)
}
