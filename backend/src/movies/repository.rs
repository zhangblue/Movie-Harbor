use crate::entities::{genre, media_asset, movie, movie_genre};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Set, sea_query::Expr,
};
use uuid::Uuid;

use super::service::MovieError;

pub async fn set_privacy(
    tx: &DatabaseTransaction,
    id: Uuid,
    expected_version: i64,
    is_private: bool,
) -> Result<movie::Model, MovieError> {
    // 隐私与生命周期独立，只更新访问范围、版本和更新时间；条件更新由数据库原子执行。
    let updated = movie::Entity::update_many()
        .col_expr(movie::Column::IsPrivate, Expr::value(is_private))
        .col_expr(
            movie::Column::Version,
            Expr::col(movie::Column::Version).add(1),
        )
        .col_expr(movie::Column::UpdatedAt, Expr::cust("CURRENT_TIMESTAMP"))
        .filter(movie::Column::Id.eq(id))
        .filter(movie::Column::Version.eq(expected_version))
        .exec_with_returning(tx)
        .await?;
    if let Some(model) = updated.into_iter().next() {
        return Ok(model);
    }
    // 匹配不到时保留领域不存在语义，已存在的记录则是旧版本冲突。
    find(tx, id).await?;
    Err(MovieError::Conflict)
}

pub async fn find<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<movie::Model, MovieError> {
    movie::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(MovieError::NotFound)
}

pub async fn find_locked(tx: &DatabaseTransaction, id: Uuid) -> Result<movie::Model, MovieError> {
    // 行锁将同一电影的命令串行化；persist 仍以 version 作为写入条件，防止陈旧读取盲目覆盖新数据。
    movie::Entity::find_by_id(id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(MovieError::NotFound)
}

pub async fn persist(
    tx: &DatabaseTransaction,
    value: &movie::Model,
    expected_version: i64,
) -> Result<movie::Model, MovieError> {
    // 即使调用方已持有行锁，也用 expected_version 保护更新；成功写入才递增版本。
    let result = movie::Entity::update_many()
        .col_expr(movie::Column::Name, Expr::value(value.name.clone()))
        .col_expr(movie::Column::Synopsis, Expr::value(value.synopsis.clone()))
        .col_expr(movie::Column::Year, Expr::value(value.year))
        .col_expr(
            movie::Column::DurationSeconds,
            Expr::value(value.duration_seconds),
        )
        .col_expr(
            movie::Column::PosterAssetId,
            Expr::value(value.poster_asset_id),
        )
        .col_expr(
            movie::Column::VideoAssetId,
            Expr::value(value.video_asset_id),
        )
        .col_expr(movie::Column::Status, Expr::value(value.status.clone()))
        .col_expr(movie::Column::Version, Expr::value(expected_version + 1))
        .col_expr(movie::Column::PublishedAt, Expr::value(value.published_at))
        .col_expr(movie::Column::ArchivedAt, Expr::value(value.archived_at))
        .col_expr(
            movie::Column::UpdatedAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(movie::Column::Id.eq(value.id))
        .filter(movie::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(MovieError::Conflict);
    }
    find(tx, value.id).await
}

pub async fn delete(
    tx: &DatabaseTransaction,
    id: Uuid,
    expected_version: i64,
) -> Result<(), MovieError> {
    let result = movie::Entity::delete_many()
        .filter(movie::Column::Id.eq(id))
        .filter(movie::Column::Version.eq(expected_version))
        .exec(tx)
        .await?;
    if result.rows_affected != 1 {
        return Err(MovieError::Conflict);
    }
    Ok(())
}

pub async fn genres<C: ConnectionTrait>(
    db: &C,
    movie_id: Uuid,
) -> Result<Vec<genre::Model>, MovieError> {
    let ids = movie_genre::Entity::find()
        .filter(movie_genre::Column::MovieId.eq(movie_id))
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
    movie_id: Uuid,
    genre_ids: &[Uuid],
) -> Result<(), MovieError> {
    movie_genre::Entity::delete_many()
        .filter(movie_genre::Column::MovieId.eq(movie_id))
        .exec(tx)
        .await?;
    for genre_id in genre_ids {
        movie_genre::ActiveModel {
            movie_id: Set(movie_id),
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
) -> Result<Option<media_asset::Model>, MovieError> {
    match id {
        Some(id) => Ok(media_asset::Entity::find_by_id(id).one(db).await?),
        None => Ok(None),
    }
}
