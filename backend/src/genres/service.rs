use crate::entities::{genre, movie_genre, series_genre};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, SqlErr, TransactionTrait,
};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug)]
pub enum GenreError {
    Invalid,
    NotFound,
    Conflict,
    Inactive,
    Database,
}

impl From<DbErr> for GenreError {
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl IntoResponse for GenreError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid genre request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "genre not found"),
            Self::Conflict => (StatusCode::CONFLICT, "genre is in use or already exists"),
            Self::Inactive => (StatusCode::UNPROCESSABLE_ENTITY, "genre is inactive"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}

pub async fn list<C: ConnectionTrait>(db: &C) -> Result<Vec<genre::Model>, GenreError> {
    Ok(genre::Entity::find()
        .order_by_asc(genre::Column::SortOrder)
        .order_by_asc(genre::Column::Id)
        .all(db)
        .await?)
}

pub async fn create(db: &DatabaseConnection, name: String) -> Result<genre::Model, GenreError> {
    let name = normalized_name(name)?;
    let tx = db.begin().await?;
    tx.execute_unprepared("LOCK TABLE genre IN EXCLUSIVE MODE")
        .await?;
    let last = genre::Entity::find()
        .order_by_desc(genre::Column::SortOrder)
        .one(&tx)
        .await?;
    let model = genre::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        sort_order: Set(last.map_or(1, |genre| genre.sort_order.saturating_add(1))),
        enabled: Set(true),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    Ok(model)
}

pub async fn rename(
    db: &DatabaseConnection,
    id: Uuid,
    name: String,
) -> Result<genre::Model, GenreError> {
    let name = normalized_name(name)?;
    let model = genre::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(GenreError::NotFound)?;
    let mut active: genre::ActiveModel = model.into();
    active.name = Set(name);
    active.updated_at = Set(Utc::now().fixed_offset());
    Ok(active.update(db).await?)
}

pub async fn deactivate(db: &DatabaseConnection, id: Uuid) -> Result<genre::Model, GenreError> {
    let model = genre::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(GenreError::NotFound)?;
    if !model.enabled {
        return Ok(model);
    }
    let mut active: genre::ActiveModel = model.into();
    active.enabled = Set(false);
    active.updated_at = Set(Utc::now().fixed_offset());
    Ok(active.update(db).await?)
}

pub async fn reorder(
    db: &DatabaseConnection,
    requested: Vec<(Uuid, i32)>,
) -> Result<Vec<genre::Model>, GenreError> {
    if requested.is_empty()
        || requested.iter().any(|(_, position)| *position <= 0)
        || requested
            .iter()
            .map(|(_, position)| position)
            .collect::<HashSet<_>>()
            .len()
            != requested.len()
        || requested
            .iter()
            .map(|(id, _)| id)
            .collect::<HashSet<_>>()
            .len()
            != requested.len()
    {
        return Err(GenreError::Invalid);
    }

    let tx = db.begin().await?;
    tx.execute_unprepared("LOCK TABLE genre IN EXCLUSIVE MODE")
        .await?;
    let current = genre::Entity::find().all(&tx).await?;
    let current_ids = current.iter().map(|genre| genre.id).collect::<HashSet<_>>();
    let requested_ids = requested.iter().map(|(id, _)| *id).collect::<HashSet<_>>();
    if requested_ids != current_ids {
        return Err(GenreError::Invalid);
    }

    for (id, sort_order) in requested {
        let mut active: genre::ActiveModel = current
            .iter()
            .find(|genre| genre.id == id)
            .cloned()
            .ok_or(GenreError::Invalid)?
            .into();
        active.sort_order = Set(sort_order);
        active.updated_at = Set(Utc::now().fixed_offset());
        active.update(&tx).await?;
    }
    let result = list(&tx).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn delete(db: &DatabaseConnection, id: Uuid) -> Result<(), GenreError> {
    let tx = db.begin().await?;
    let model = genre::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(GenreError::NotFound)?;
    let movie_reference = movie_genre::Entity::find()
        .filter(movie_genre::Column::GenreId.eq(id))
        .one(&tx)
        .await?;
    let series_reference = series_genre::Entity::find()
        .filter(series_genre::Column::GenreId.eq(id))
        .one(&tx)
        .await?;
    if movie_reference.is_some() || series_reference.is_some() {
        return Err(GenreError::Conflict);
    }
    genre::Entity::delete(model.into_active_model())
        .exec(&tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Validate genre IDs before a movie or series command creates new associations.
pub async fn ensure_associable<C: ConnectionTrait>(db: &C, ids: &[Uuid]) -> Result<(), GenreError> {
    let distinct = ids.iter().copied().collect::<HashSet<_>>();
    if distinct.len() != ids.len() {
        return Err(GenreError::Invalid);
    }
    let found = genre::Entity::find()
        .filter(genre::Column::Id.is_in(distinct))
        .all(db)
        .await?;
    if found.len() != ids.len() {
        return Err(GenreError::NotFound);
    }
    if found.iter().any(|genre| !genre.enabled) {
        return Err(GenreError::Inactive);
    }
    Ok(())
}

fn normalized_name(name: String) -> Result<String, GenreError> {
    let name = name.trim();
    if name.is_empty() {
        Err(GenreError::Invalid)
    } else {
        Ok(name.to_owned())
    }
}
