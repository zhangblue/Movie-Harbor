use super::{
    dto::{CreateGenreRequest, GenreResponse, ReorderGenresRequest, UpdateGenreRequest},
    service::{self, GenreError},
};
use crate::auth::{self, AuthState};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    routing::{get, patch, post, put},
};
use uuid::Uuid;

pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/genres", get(list).post(create))
        .route("/api/admin/genres/order", put(reorder))
        .route("/api/admin/genres/{id}", patch(rename).delete(delete_genre))
        .route("/api/admin/genres/{id}/deactivate", post(deactivate))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::routes::require_session,
        ))
        .with_state(state)
}

async fn list(State(state): State<AuthState>) -> Result<Json<Vec<GenreResponse>>, GenreError> {
    Ok(Json(
        service::list(&state.db)
            .await?
            .into_iter()
            .map(GenreResponse::from)
            .collect(),
    ))
}

async fn create(
    State(state): State<AuthState>,
    Json(request): Json<CreateGenreRequest>,
) -> Result<(StatusCode, Json<GenreResponse>), GenreError> {
    let model = service::create(&state.db, request.name).await?;
    Ok((StatusCode::CREATED, Json(model.into())))
}

async fn rename(
    State(state): State<AuthState>,
    Path(id): Path<String>,
    Json(request): Json<UpdateGenreRequest>,
) -> Result<Json<GenreResponse>, GenreError> {
    let id = parse_id(id)?;
    Ok(Json(
        service::rename(&state.db, id, request.name).await?.into(),
    ))
}

async fn reorder(
    State(state): State<AuthState>,
    Json(request): Json<ReorderGenresRequest>,
) -> Result<Json<Vec<GenreResponse>>, GenreError> {
    let requested = request
        .items
        .into_iter()
        .map(|item| {
            item.id
                .parse()
                .map(|id| (id, item.sort_order))
                .map_err(|_| GenreError::Invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(
        service::reorder(&state.db, requested)
            .await?
            .into_iter()
            .map(GenreResponse::from)
            .collect(),
    ))
}

async fn deactivate(
    State(state): State<AuthState>,
    Path(id): Path<String>,
) -> Result<Json<GenreResponse>, GenreError> {
    let id = parse_id(id)?;
    Ok(Json(service::deactivate(&state.db, id).await?.into()))
}

async fn delete_genre(
    State(state): State<AuthState>,
    Path(id): Path<String>,
) -> Result<StatusCode, GenreError> {
    let id = parse_id(id)?;
    service::delete(&state.db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_id(id: String) -> Result<Uuid, GenreError> {
    id.parse().map_err(|_| GenreError::Invalid)
}
