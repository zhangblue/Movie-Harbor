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
        db,
        cookie_secure: config.cookie_secure,
        public_origin,
        limits: Default::default(),
    };
    Ok(router().merge(crate::auth::routes::router(state)))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
