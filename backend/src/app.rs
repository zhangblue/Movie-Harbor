use axum::{Json, Router, routing::get};
use serde::Serialize;

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
        limits: Default::default(),
    };
    let storage = crate::media::LocalMediaStorage::initialize(&config.media_dir).await?;
    let policy = crate::media::UploadPolicy::new(
        config.max_upload_bytes,
        config.allowed_video_mime_types.iter(),
    )?;
    crate::media::cleanup::spawn(db.clone(), storage.clone());
    Ok(router()
        .merge(crate::auth::routes::router(state.clone()))
        .merge(crate::genres::routes::router(state.clone()))
        .merge(crate::media::routes::router(state, storage, policy)))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
