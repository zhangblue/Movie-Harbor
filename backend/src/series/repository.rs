use crate::entities::{episode, genre, media_asset, season, series, series_genre};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Set, sea_query::Expr,
};
use uuid::Uuid;

use super::service::SeriesError;

/// 在访问范围变更请求中按版本修改隐私设置并返回更新结果。
pub async fn set_privacy(
    tx: &DatabaseTransaction,
    id: Uuid,
    expected_version: i64,
    is_private: bool,
) -> Result<series::Model, SeriesError> {
    // 隐私与生命周期独立，只更新访问范围、版本和更新时间；条件更新由数据库原子执行。
    let updated = series::Entity::update_many()
        .col_expr(series::Column::IsPrivate, Expr::value(is_private))
        .col_expr(
            series::Column::Version,
            Expr::col(series::Column::Version).add(1),
        )
        .col_expr(series::Column::UpdatedAt, Expr::cust("CURRENT_TIMESTAMP"))
        .filter(series::Column::Id.eq(id))
        .filter(series::Column::Version.eq(expected_version))
        .exec_with_returning(tx)
        .await?;
    if let Some(model) = updated.into_iter().next() {
        return Ok(model);
    }
    // 匹配不到时保留领域不存在语义，已存在的记录则是旧版本冲突。
    find(tx, id).await?;
    Err(SeriesError::Conflict)
}

/// 在读取或校验内容时按标识查询记录，不存在时返回领域错误。
pub async fn find<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<series::Model, SeriesError> {
    series::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)
}

/// 在内容写事务开始时锁定记录，供后续状态与版本检查使用。
pub async fn find_locked(tx: &DatabaseTransaction, id: Uuid) -> Result<series::Model, SeriesError> {
    // 层级写入先锁定 series，随后才锁定 season 和 episode，以统一全局加锁顺序。
    series::Entity::find_by_id(id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

/// 在剧集写事务中按预期版本保存记录并递增版本，冲突时拒绝覆盖。
pub async fn persist_series(
    tx: &DatabaseTransaction,
    value: &series::Model,
    expected_version: i64,
) -> Result<series::Model, SeriesError> {
    // 将 expected_version 写入 WHERE 条件并在成功后递增，避免陈旧请求覆盖同一剧集或子级变更后的版本。
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

/// 在子级发生变化后递增父剧集版本，使旧客户端的后续写入发生冲突。
pub async fn bump_series(
    tx: &DatabaseTransaction,
    value: &series::Model,
) -> Result<series::Model, SeriesError> {
    persist_series(tx, value, value.version).await
}

/// 在删除剧集事务中按预期版本删除记录，版本不匹配时返回冲突。
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

/// 在读取剧集详情时按季序号和标识稳定排序返回各季。
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

/// 在锁定父剧集后锁定其所属季，供层级写入检查使用。
pub async fn season_locked(
    tx: &DatabaseTransaction,
    series_id: Uuid,
    season_id: Uuid,
) -> Result<season::Model, SeriesError> {
    // 在已锁定父剧集后再锁定所属季，保证 series -> season 的层级顺序。
    season::Entity::find()
        .filter(season::Column::Id.eq(season_id))
        .filter(season::Column::SeriesId.eq(series_id))
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

/// 在读取季详情时按集序号和标识稳定排序返回单集。
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

/// 在级联操作中按标识顺序锁定季内单集，保持一致的锁顺序。
pub async fn episodes_locked(
    tx: &DatabaseTransaction,
    season_id: Uuid,
) -> Result<Vec<episode::Model>, SeriesError> {
    // 级联操作按 UUID 顺序锁定同季单集，使多个子项的锁定次序保持一致。
    Ok(episode::Entity::find()
        .filter(episode::Column::SeasonId.eq(season_id))
        .order_by_asc(episode::Column::Id)
        .lock_exclusive()
        .all(tx)
        .await?)
}

/// 在锁定父剧集和季后锁定所属单集，供层级写入检查使用。
pub async fn episode_locked(
    tx: &DatabaseTransaction,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<episode::Model, SeriesError> {
    // 单集操作在持有 series、season 锁后才取得该行锁，完成 series -> season -> episode 顺序。
    episode::Entity::find()
        .filter(episode::Column::Id.eq(episode_id))
        .filter(episode::Column::SeasonId.eq(season_id))
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(SeriesError::NotFound)
}

/// 在单集写事务中按预期版本保存记录并递增版本，冲突时拒绝覆盖。
pub async fn persist_episode(
    tx: &DatabaseTransaction,
    value: &episode::Model,
    expected_version: i64,
) -> Result<episode::Model, SeriesError> {
    // 以单集 expected_version 拒绝陈旧写入；上层服务会在同一事务中同步递增父剧集版本。
    let result = episode::Entity::update_many()
        .col_expr(episode::Column::Number, Expr::value(value.number))
        .col_expr(episode::Column::Name, Expr::value(value.name.clone()))
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

/// 在删除单集事务中按预期版本删除记录，版本不匹配时返回冲突。
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

/// 在组装内容响应时按稳定顺序读取关联题材。
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

/// 在内容写事务中替换题材关联，使关系与内容更新一并提交。
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

/// 在组装内容响应时按可选标识读取媒体资产。
pub async fn asset<C: ConnectionTrait>(
    db: &C,
    id: Option<Uuid>,
) -> Result<Option<media_asset::Model>, SeriesError> {
    match id {
        Some(id) => Ok(media_asset::Entity::find_by_id(id).one(db).await?),
        None => Ok(None),
    }
}
