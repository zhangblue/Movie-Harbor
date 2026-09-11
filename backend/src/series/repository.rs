use crate::entities::{episode, genre, media_asset, season, series, series_genre};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Set, sea_query::Expr,
};
use uuid::Uuid;

use super::service::SeriesError;

pub async fn find<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<series::Model, SeriesError> {
    series::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)
}

pub async fn find_locked(tx: &DatabaseTransaction, id: Uuid) -> Result<series::Model, SeriesError> {
    series::Entity::find_by_id(id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

pub async fn persist_series(
    tx: &DatabaseTransaction,
    value: &series::Model,
    expected_version: i64,
) -> Result<series::Model, SeriesError> {
    let result = series::Entity::update_many()
        .col_expr(series::Column::Name, Expr::value(value.name.clone()))
        .col_expr(
            series::Column::Synopsis,
            Expr::value(value.synopsis.clone()),
        )
        .col_expr(series::Column::Year, Expr::value(value.year))
        .col_expr(
            series::Column::PosterAssetId,
            Expr::value(value.poster_asset_id),
        )
        .col_expr(series::Column::Status, Expr::value(value.status.clone()))
        .col_expr(series::Column::Version, Expr::value(expected_version + 1))
        .col_expr(series::Column::PublishedAt, Expr::value(value.published_at))
        .col_expr(series::Column::ArchivedAt, Expr::value(value.archived_at))
        .col_expr(
            series::Column::UpdatedAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(series::Column::Id.eq(value.id))
        .filter(series::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(SeriesError::Conflict);
    }
    find(tx, value.id).await
}

pub async fn bump_series(
    tx: &DatabaseTransaction,
    value: &series::Model,
) -> Result<series::Model, SeriesError> {
    persist_series(tx, value, value.version).await
}

pub async fn delete_series(
    tx: &DatabaseTransaction,
    id: Uuid,
    expected_version: i64,
) -> Result<(), SeriesError> {
    let result = series::Entity::delete_many()
        .filter(series::Column::Id.eq(id))
        .filter(series::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(SeriesError::Conflict);
    }
    Ok(())
}

pub async fn seasons<C: ConnectionTrait>(
    db: &C,
    series_id: Uuid,
) -> Result<Vec<season::Model>, SeriesError> {
    Ok(season::Entity::find()
        .filter(season::Column::SeriesId.eq(series_id))
        .order_by_asc(season::Column::Number)
        .order_by_asc(season::Column::Id)
        .all(db)
        .await?)
}

pub async fn season_locked(
    tx: &DatabaseTransaction,
    series_id: Uuid,
    season_id: Uuid,
) -> Result<season::Model, SeriesError> {
    season::Entity::find()
        .filter(season::Column::Id.eq(season_id))
        .filter(season::Column::SeriesId.eq(series_id))
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

pub async fn episodes<C: ConnectionTrait>(
    db: &C,
    season_id: Uuid,
) -> Result<Vec<episode::Model>, SeriesError> {
    Ok(episode::Entity::find()
        .filter(episode::Column::SeasonId.eq(season_id))
        .order_by_asc(episode::Column::Number)
        .order_by_asc(episode::Column::Id)
        .all(db)
        .await?)
}

pub async fn episodes_locked(
    tx: &DatabaseTransaction,
    season_id: Uuid,
) -> Result<Vec<episode::Model>, SeriesError> {
    Ok(episode::Entity::find()
        .filter(episode::Column::SeasonId.eq(season_id))
        .order_by_asc(episode::Column::Id)
        .lock_exclusive()
        .all(tx)
        .await?)
}

pub async fn episode_locked(
    tx: &DatabaseTransaction,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<episode::Model, SeriesError> {
    episode::Entity::find()
        .filter(episode::Column::Id.eq(episode_id))
        .filter(episode::Column::SeasonId.eq(season_id))
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

pub async fn persist_episode(
    tx: &DatabaseTransaction,
    value: &episode::Model,
    expected_version: i64,
) -> Result<episode::Model, SeriesError> {
    let result = episode::Entity::update_many()
        .col_expr(episode::Column::Number, Expr::value(value.number))
        .col_expr(episode::Column::Name, Expr::value(value.name.clone()))
        .col_expr(
            episode::Column::Synopsis,
            Expr::value(value.synopsis.clone()),
        )
        .col_expr(
            episode::Column::DurationSeconds,
            Expr::value(value.duration_seconds),
        )
        .col_expr(
            episode::Column::VideoAssetId,
            Expr::value(value.video_asset_id),
        )
        .col_expr(episode::Column::Status, Expr::value(value.status.clone()))
        .col_expr(episode::Column::Version, Expr::value(expected_version + 1))
        .col_expr(
            episode::Column::PublishedAt,
            Expr::value(value.published_at),
        )
        .col_expr(episode::Column::ArchivedAt, Expr::value(value.archived_at))
        .col_expr(
            episode::Column::UpdatedAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(episode::Column::Id.eq(value.id))
        .filter(episode::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(SeriesError::Conflict);
    }
    episode::Entity::find_by_id(value.id)
        .one(tx)
        .await?
        .ok_or(SeriesError::Conflict)
}

pub async fn delete_episode(
    tx: &DatabaseTransaction,
    id: Uuid,
    expected_version: i64,
) -> Result<(), SeriesError> {
    let result = episode::Entity::delete_many()
        .filter(episode::Column::Id.eq(id))
        .filter(episode::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(SeriesError::Conflict);
    }
    Ok(())
}

pub async fn genres<C: ConnectionTrait>(
    db: &C,
    series_id: Uuid,
) -> Result<Vec<genre::Model>, SeriesError> {
    let ids = series_genre::Entity::find()
        .filter(series_genre::Column::SeriesId.eq(series_id))
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.genre_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(genre::Entity::find()
        .filter(genre::Column::Id.is_in(ids))
        .order_by_asc(genre::Column::SortOrder)
        .order_by_asc(genre::Column::Id)
        .all(db)
        .await?)
}

pub async fn replace_genres(
    tx: &DatabaseTransaction,
    series_id: Uuid,
    genre_ids: &[Uuid],
) -> Result<(), SeriesError> {
    series_genre::Entity::delete_many()
        .filter(series_genre::Column::SeriesId.eq(series_id))
        .exec(tx)
        .await?;
    for genre_id in genre_ids {
        series_genre::ActiveModel {
            series_id: Set(series_id),
            genre_id: Set(*genre_id),
        }
        .insert(tx)
        .await?;
    }
    Ok(())
}

pub async fn asset<C: ConnectionTrait>(
    db: &C,
    id: Option<Uuid>,
) -> Result<Option<media_asset::Model>, SeriesError> {
    match id {
        Some(id) => Ok(media_asset::Entity::find_by_id(id).one(db).await?),
        None => Ok(None),
    }
}
