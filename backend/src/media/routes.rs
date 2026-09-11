use super::{AttachmentTarget, LocalMediaStorage, MediaError, UploadPolicy, replace_attachment};
use crate::{
    auth::{self, AuthState},
    entities::media_asset,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    middleware,
    routing::post,
};
use sea_orm::DatabaseConnection;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone)]
struct MediaState {
    db: DatabaseConnection,
    storage: LocalMediaStorage,
    policy: UploadPolicy,
}

#[derive(Serialize)]
struct MediaAssetResponse {
    id: String,
    original_name: String,
    mime_type: String,
    byte_size: i64,
}

impl From<media_asset::Model> for MediaAssetResponse {
    fn from(asset: media_asset::Model) -> Self {
        Self {
            id: asset.id.to_string(),
            original_name: asset.original_name,
            mime_type: asset.mime_type,
            byte_size: asset.byte_size,
        }
    }
}

pub fn router(auth_state: AuthState, storage: LocalMediaStorage, policy: UploadPolicy) -> Router {
    let state = MediaState {
        db: auth_state.db.clone(),
        storage,
        policy,
    };
    Router::new()
        .route("/api/admin/media/movies/{id}/poster", post(movie_poster))
        .route("/api/admin/media/movies/{id}/video", post(movie_video))
        .route("/api/admin/media/series/{id}/poster", post(series_poster))
        .route("/api/admin/media/episodes/{id}/video", post(episode_video))
        .route_layer(DefaultBodyLimit::disable())
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        .with_state(state)
}

async fn movie_poster(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::MoviePoster(parse_id(id)?),
        multipart,
    )
    .await
}

async fn movie_video(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::MovieVideo(parse_id(id)?),
        multipart,
    )
    .await
}

async fn series_poster(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::SeriesPoster(parse_id(id)?),
        multipart,
    )
    .await
}

async fn episode_video(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::EpisodeVideo(parse_id(id)?),
        multipart,
    )
    .await
}

fn parse_id(id: String) -> Result<Uuid, MediaError> {
    id.parse().map_err(|_| MediaError::TargetNotFound)
}

async fn upload(
    state: MediaState,
    target: AttachmentTarget,
    mut multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|error| MediaError::Multipart(error.to_string()))?
        .ok_or(MediaError::InvalidFileName)?;
    if field.name() != Some("file") {
        return Err(MediaError::InvalidFileName);
    }
    let original_name = field
        .file_name()
        .ok_or(MediaError::InvalidFileName)?
        .to_owned();
    let declared_mime = field
        .content_type()
        .ok_or(MediaError::UnsupportedType)?
        .to_owned();
    let asset = replace_attachment(
        &state.db,
        &state.storage,
        target,
        &original_name,
        &declared_mime,
        &state.policy,
        field,
    )
    .await?;
    Ok(Json(asset.into()))
}
