use super::{AttachmentTarget, MediaError, MediaStorageSet, UploadPolicy};
use crate::{
    auth::{self, AuthState},
    entities::media_asset,
    route_params::parse_uuid,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, header::CONTENT_LENGTH},
    middleware,
    routing::post,
};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct MediaState {
    db: DatabaseConnection,
    storage: MediaStorageSet,
    policy: UploadPolicy,
}

#[derive(Serialize)]
struct MediaAssetResponse {
    id: String,
    original_name: String,
    mime_type: String,
    byte_size: i64,
    version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    series_version: Option<i64>,
}

#[derive(Deserialize)]
struct VersionQuery {
    version: i64,
}

impl MediaAssetResponse {
    fn new(asset: media_asset::Model, version: i64, series_version: Option<i64>) -> Self {
        Self {
            id: asset.id.to_string(),
            original_name: asset.original_name,
            mime_type: asset.mime_type,
            byte_size: asset.byte_size,
            version,
            series_version,
        }
    }
}

const MULTIPART_OVERHEAD_BYTES: usize = 64 * 1024;
const MAX_FILE_NAME_BYTES: usize = 255;

pub fn router(
    auth_state: AuthState,
    storage: MediaStorageSet,
    policy: UploadPolicy,
) -> Result<Router, MediaError> {
    let body_limit = usize::try_from(policy.max_bytes())
        .ok()
        .and_then(|limit| limit.checked_add(MULTIPART_OVERHEAD_BYTES))
        .ok_or(MediaError::TooLarge)?;
    let state = MediaState {
        db: auth_state.db.clone(),
        storage,
        policy,
    };
    Ok(Router::new()
        .route("/api/admin/media/movies/{id}/poster", post(movie_poster))
        .route("/api/admin/media/movies/{id}/video", post(movie_video))
        .route("/api/admin/media/series/{id}/poster", post(series_poster))
        .route("/api/admin/media/episodes/{id}/video", post(episode_video))
        .route_layer(DefaultBodyLimit::max(body_limit))
        .route_layer(middleware::from_fn_with_state(
            auth_state,
            auth::routes::require_session,
        ))
        .with_state(state))
}

async fn movie_poster(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    Query(version): Query<VersionQuery>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::MoviePoster {
            id: parse_uuid(id, MediaError::TargetNotFound)?,
            version: version.version,
        },
        headers,
        multipart,
    )
    .await
}

async fn movie_video(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    Query(version): Query<VersionQuery>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::MovieVideo {
            id: parse_uuid(id, MediaError::TargetNotFound)?,
            version: version.version,
        },
        headers,
        multipart,
    )
    .await
}

async fn series_poster(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    Query(version): Query<VersionQuery>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::SeriesPoster {
            id: parse_uuid(id, MediaError::TargetNotFound)?,
            version: version.version,
        },
        headers,
        multipart,
    )
    .await
}

async fn episode_video(
    State(state): State<MediaState>,
    Path(id): Path<String>,
    Query(version): Query<VersionQuery>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    upload(
        state,
        AttachmentTarget::EpisodeVideo {
            id: parse_uuid(id, MediaError::TargetNotFound)?,
            version: version.version,
        },
        headers,
        multipart,
    )
    .await
}

async fn upload(
    state: MediaState,
    target: AttachmentTarget,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<MediaAssetResponse>, MediaError> {
    let field = multipart
        .next_field()
        .await
        .map_err(map_multipart_error)?
        .ok_or(MediaError::InvalidFileName)?;
    if field.name() != Some("file") {
        return Err(MediaError::InvalidFileName);
    }
    let original_name = field
        .file_name()
        .ok_or(MediaError::InvalidFileName)?
        .to_owned();
    if original_name.len() > MAX_FILE_NAME_BYTES {
        return Err(MediaError::InvalidFileName);
    }
    let declared_mime = field
        .content_type()
        .ok_or(MediaError::UnsupportedType)?
        .to_owned();
    let required_bytes = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(state.policy.max_bytes());
    let pending = super::upload::prepare_attachment(
        &state.storage,
        target,
        &original_name,
        &declared_mime,
        &state.policy,
        required_bytes,
        field,
    )
    .await?;
    if multipart
        .next_field()
        .await
        .map_err(map_multipart_error)?
        .is_some()
    {
        return Err(MediaError::Multipart(
            "exactly one file field is required".into(),
        ));
    }
    let committed = super::upload::commit_attachment(&state.db, pending).await?;
    Ok(Json(MediaAssetResponse::new(
        committed.asset,
        committed.version,
        committed.series_version,
    )))
}

fn map_multipart_error(error: axum::extract::multipart::MultipartError) -> MediaError {
    if error.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        MediaError::TooLarge
    } else {
        MediaError::Multipart(error.to_string())
    }
}
