use super::dto::{ContentExport, ExportEpisode, ExportMovie, ExportSeries};
use crate::{
    entities::{episode, genre, media_asset, movie, movie_genre, season, series, series_genre},
    media::path::controlled_media_path,
};
use sea_orm::{
    AccessMode, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, FromQueryResult,
    IsolationLevel, JoinType, QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationTrait,
    TransactionTrait, sea_query::UnionType,
};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(FromQueryResult)]
// 承载导出快照中的电影行，供组装电影导出数据使用。
struct MovieRow {
    id: Uuid,
    is_private: bool,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
    video_asset_id: Option<Uuid>,
    duration_seconds: Option<i32>,
}

#[derive(FromQueryResult)]
// 承载导出快照中的剧集行，供组装剧集导出数据使用。
struct SeriesRow {
    id: Uuid,
    is_private: bool,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
}

#[derive(FromQueryResult)]
// 承载导出快照中的单集行，供按剧集组装单集使用。
struct EpisodeRow {
    series_id: Uuid,
    season_number: i32,
    episode_number: i32,
    name: String,
    video_asset_id: Option<Uuid>,
    duration_seconds: Option<i32>,
}

#[derive(FromQueryResult)]
// 承载导出快照中的媒体标识和存储键，供生成受控路径使用。
struct MediaRow {
    id: Uuid,
    storage_key: String,
}

#[derive(FromQueryResult)]
// 承载内容与题材名称的关联行，供导出时按内容分组。
struct GenreRow {
    content_id: Uuid,
    name: String,
}

// 在只读一致性快照中读取并组装全量内容，供导出路由调用。
pub async fn export(db: &DatabaseConnection, exported_at: String) -> Result<ContentExport, DbErr> {
    // 父内容、题材、单集和媒体必须在同一只读快照中读取，导出不能混入并发修改的关联数据。
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let movies = movie::Entity::find()
        .select_only()
        .columns([
            movie::Column::Id,
            movie::Column::IsPrivate,
            movie::Column::Name,
            movie::Column::Synopsis,
            movie::Column::Year,
            movie::Column::PosterAssetId,
            movie::Column::VideoAssetId,
            movie::Column::DurationSeconds,
        ])
        .order_by_asc(movie::Column::Name)
        .order_by_asc(movie::Column::Id)
        .into_model::<MovieRow>()
        .all(&tx)
        .await?;
    let series = series::Entity::find()
        .select_only()
        .columns([
            series::Column::Id,
            series::Column::IsPrivate,
            series::Column::Name,
            series::Column::Synopsis,
            series::Column::Year,
            series::Column::PosterAssetId,
        ])
        .order_by_asc(series::Column::Name)
        .order_by_asc(series::Column::Id)
        .into_model::<SeriesRow>()
        .all(&tx)
        .await?;
    // 批量读取全部父级题材并按系统顺序归组，既避免 N+1，也保留已停用的历史关联。
    let movie_genres = movie_genre::Entity::find()
        .select_only()
        .column_as(movie_genre::Column::MovieId, "content_id")
        .column(genre::Column::Name)
        .join(JoinType::InnerJoin, movie_genre::Relation::Genre.def())
        .order_by_asc(movie_genre::Column::MovieId)
        .order_by_asc(genre::Column::SortOrder)
        .order_by_asc(genre::Column::Id)
        .into_model::<GenreRow>()
        .all(&tx)
        .await?;
    let series_genres = series_genre::Entity::find()
        .select_only()
        .column_as(series_genre::Column::SeriesId, "content_id")
        .column(genre::Column::Name)
        .join(JoinType::InnerJoin, series_genre::Relation::Genre.def())
        .order_by_asc(series_genre::Column::SeriesId)
        .order_by_asc(genre::Column::SortOrder)
        .order_by_asc(genre::Column::Id)
        .into_model::<GenreRow>()
        .all(&tx)
        .await?;
    let episodes = episode::Entity::find()
        .select_only()
        .column(season::Column::SeriesId)
        .column_as(season::Column::Number, "season_number")
        .column_as(episode::Column::Number, "episode_number")
        .columns([
            episode::Column::Name,
            episode::Column::VideoAssetId,
            episode::Column::DurationSeconds,
        ])
        .join(JoinType::InnerJoin, episode::Relation::Season.def())
        .order_by_asc(season::Column::SeriesId)
        .order_by_asc(season::Column::Number)
        .order_by_asc(episode::Column::Number)
        .order_by_asc(episode::Column::Id)
        .into_model::<EpisodeRow>()
        .all(&tx)
        .await?;
    // 只查询被内容引用的媒体；通过数据库子查询汇总外键，避免把全部 ID 作为绑定参数传入。
    let mut referenced_assets = movie::Entity::find()
        .select_only()
        .column(movie::Column::PosterAssetId)
        .into_query();
    referenced_assets.unions([
        (
            UnionType::All,
            movie::Entity::find()
                .select_only()
                .column(movie::Column::VideoAssetId)
                .into_query(),
        ),
        (
            UnionType::All,
            series::Entity::find()
                .select_only()
                .column(series::Column::PosterAssetId)
                .into_query(),
        ),
        (
            UnionType::All,
            episode::Entity::find()
                .select_only()
                .column(episode::Column::VideoAssetId)
                .into_query(),
        ),
    ]);
    let media = media_asset::Entity::find()
        .select_only()
        .columns([media_asset::Column::Id, media_asset::Column::StorageKey])
        .filter(media_asset::Column::Id.in_subquery(referenced_assets))
        .into_model::<MediaRow>()
        .all(&tx)
        .await?
        .into_iter()
        .map(|row| (row.id, row.storage_key))
        .collect::<HashMap<_, _>>();

    let mut movie_genres = group_genres(movie_genres);
    let movies = movies
        .into_iter()
        .map(|row| {
            Ok(ExportMovie {
                name: row.name,
                is_private: row.is_private,
                synopsis: row.synopsis,
                year: row.year,
                genres: movie_genres.remove(&row.id).unwrap_or_default(),
                poster_path: media_path(&media, row.poster_asset_id, "poster")?,
                video_path: media_path(&media, row.video_asset_id, "video")?,
                duration_seconds: row.duration_seconds,
            })
        })
        .collect::<Result<Vec<_>, DbErr>>()?;

    let mut by_series: HashMap<Uuid, Vec<ExportEpisode>> = HashMap::new();
    for row in episodes {
        by_series
            .entry(row.series_id)
            .or_default()
            .push(ExportEpisode {
                season_number: row.season_number,
                episode_number: row.episode_number,
                name: row.name,
                video_path: media_path(&media, row.video_asset_id, "video")?,
                duration_seconds: row.duration_seconds,
            });
    }
    let mut series_genres = group_genres(series_genres);
    let series = series
        .into_iter()
        .map(|row| {
            Ok(ExportSeries {
                name: row.name,
                is_private: row.is_private,
                synopsis: row.synopsis,
                year: row.year,
                genres: series_genres.remove(&row.id).unwrap_or_default(),
                poster_path: media_path(&media, row.poster_asset_id, "poster")?,
                episodes: by_series.remove(&row.id).unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, DbErr>>()?;
    tx.commit().await?;
    Ok(ContentExport {
        exported_at,
        movies,
        series,
    })
}

// 按内容标识归组有序题材名称，供导出结果组装时调用。
fn group_genres(rows: Vec<GenreRow>) -> HashMap<Uuid, Vec<String>> {
    let mut grouped: HashMap<Uuid, Vec<String>> = HashMap::new();
    for row in rows {
        grouped.entry(row.content_id).or_default().push(row.name);
    }
    grouped
}

// 从受控存储键生成媒体路径，供组装导出项时调用。
fn media_path(
    media: &HashMap<Uuid, String>,
    id: Option<Uuid>,
    kind: &str,
) -> Result<Option<String>, DbErr> {
    id.map(|id| {
        media
            .get(&id)
            .and_then(|key| controlled_media_path(key, kind))
            .ok_or_else(|| DbErr::Custom("invalid export media path".into()))
    })
    .transpose()
}
