use super::{
    dto::{CatalogFilter, CatalogRequest, MovieDetail, SeriesDetail},
    query,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use sea_orm::{DatabaseConnection, DbErr};
use uuid::Uuid;

#[derive(Clone)]
struct CatalogState {
    db: DatabaseConnection,
}

#[derive(Debug)]
enum CatalogError {
    Invalid,
    NotFound,
    Database,
}

impl From<DbErr> for CatalogError {
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl IntoResponse for CatalogError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid catalog request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "content not found"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

pub fn router(db: DatabaseConnection) -> Router {
    Router::new()
        .route("/api/catalog", get(list))
        .route("/api/catalog/movies/{id}", get(movie_detail))
        .route("/api/catalog/series/{id}", get(series_detail))
        .with_state(CatalogState { db })
}

async fn list(
    State(state): State<CatalogState>,
    Query(request): Query<CatalogRequest>,
) -> Result<Json<super::dto::CatalogPage>, CatalogError> {
    let filter = CatalogFilter::try_from(request).map_err(|_| CatalogError::Invalid)?;
    Ok(Json(query::list(&state.db, filter).await?))
}

async fn movie_detail(
    State(state): State<CatalogState>,
    Path(id): Path<String>,
) -> Result<Json<MovieDetail>, CatalogError> {
    let id = parse_id(id)?;
    query::movie_detail(&state.db, id)
        .await?
        .map(Json)
        .ok_or(CatalogError::NotFound)
}

async fn series_detail(
    State(state): State<CatalogState>,
    Path(id): Path<String>,
) -> Result<Json<SeriesDetail>, CatalogError> {
    let id = parse_id(id)?;
    query::series_detail(&state.db, id)
        .await?
        .map(Json)
        .ok_or(CatalogError::NotFound)
}

fn parse_id(value: String) -> Result<Uuid, CatalogError> {
    value.parse().map_err(|_| CatalogError::NotFound)
}
