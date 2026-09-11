use crate::entities::{episode, file_cleanup_job, media_asset, movie, series};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, Set,
    sea_query::OnConflict,
};
use uuid::Uuid;

/// Lock every existing candidate asset in UUID order before removing any reference to it.
///
/// All content writers acquire their content hierarchy locks first and these media locks second.
/// Under PostgreSQL READ COMMITTED, a concurrent remover waiting here runs its later reference
/// checks with fresh statement snapshots after the preceding remover commits, so the final remover
/// can observe that no reference remains and enqueue cleanup exactly once.
pub(crate) async fn lock_for_reference_removal<C, I>(db: &C, ids: I) -> Result<Vec<Uuid>, DbErr>
where
    C: ConnectionTrait,
    I: IntoIterator<Item = Uuid>,
{
    let mut ids = ids.into_iter().collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    for id in &ids {
        media_asset::Entity::find_by_id(*id)
            .lock_exclusive()
            .one(db)
            .await?;
    }
    Ok(ids)
}

/// Decide cleanup only while holding the asset locks acquired by
/// [`lock_for_reference_removal`].
pub(crate) async fn queue_locked_if_unreferenced<C: ConnectionTrait>(
    db: &C,
    locked_ids: &[Uuid],
) -> Result<(), DbErr> {
    for asset_id in locked_ids {
        if is_referenced(db, *asset_id).await? {
            continue;
        }
        file_cleanup_job::Entity::insert(file_cleanup_job::ActiveModel {
            id: Set(Uuid::new_v4()),
            media_asset_id: Set(*asset_id),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(file_cleanup_job::Column::MediaAssetId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(db)
        .await?;
    }
    Ok(())
}

pub(crate) async fn is_referenced<C: ConnectionTrait>(
    db: &C,
    asset_id: Uuid,
) -> Result<bool, DbErr> {
    let movie_reference = movie::Entity::find()
        .filter(
            movie::Column::PosterAssetId
                .eq(asset_id)
                .or(movie::Column::VideoAssetId.eq(asset_id)),
        )
        .one(db)
        .await?;
    let series_reference = series::Entity::find()
        .filter(series::Column::PosterAssetId.eq(asset_id))
        .one(db)
        .await?;
    let episode_reference = episode::Entity::find()
        .filter(episode::Column::VideoAssetId.eq(asset_id))
        .one(db)
        .await?;
    Ok(movie_reference.is_some() || series_reference.is_some() || episode_reference.is_some())
}
