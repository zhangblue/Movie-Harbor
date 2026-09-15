use axum::{Json, Router, routing::get};
use sea_orm::{EntityTrait, QuerySelect};
use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

pub fn router() -> Router {
    Router::new().route("/api/health", get(health))
}

pub fn test_router() -> Router {
    router()
}

pub async fn build(
    db: sea_orm::DatabaseConnection,
    config: &crate::config::Config,
) -> Result<Router, Box<dyn std::error::Error>> {
    let public_origin = config.validated_origin()?;
    crate::auth::initialize(&db, config).await?;
    let state = crate::auth::AuthState {
        db: db.clone(),
        cookie_secure: config.cookie_secure,
        public_origin,
        trust_proxy_headers: config.trust_proxy_headers,
        trusted_proxy_secret_digest: config
            .trusted_proxy_secret
            .as_deref()
            .map(crate::auth::csrf::digest),
        limits: Default::default(),
        password_work: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let storage = crate::media::MediaStorageSet::initialize(
        &config.media_dirs,
        config.media_disk_reserve_bytes,
    )
    .await?;
    let registered_volumes: Vec<i32> = crate::entities::media_asset::Entity::find()
        .select_only()
        .column(crate::entities::media_asset::Column::StorageVolume)
        .distinct()
        .into_tuple()
        .all(&db)
        .await?;
    for volume in registered_volumes {
        if storage.volume(volume).is_none() {
            return Err(crate::media::MediaError::UnconfiguredVolume(volume).into());
        }
    }
    let policy = crate::media::UploadPolicy::new(
        config.max_upload_bytes,
        config.allowed_video_mime_types.iter(),
    )?;
    crate::media::upload::recover_stale_uploads(&db, &storage, Duration::from_secs(3600)).await?;
    crate::media::removal::recover(&db, &storage).await?;
    Ok(router()
        .merge(crate::catalog::routes::router(db))
        .merge(crate::auth::routes::router(state.clone()))
        .merge(crate::admin_content::routes::router(state.clone()))
        .merge(crate::genres::routes::router(state.clone()))
        .merge(crate::movies::routes::router(
            state.clone(),
            storage.clone(),
            config.allowed_video_mime_types.clone(),
        ))
        .merge(crate::series::routes::router(
            state.clone(),
            storage.clone(),
            config.allowed_video_mime_types.clone(),
        ))
        .merge(crate::media::routes::router(state, storage, policy)?))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
