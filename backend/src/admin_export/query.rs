use super::dto::{ContentExport, ExportEpisode, ExportMovie, ExportSeries};
use crate::media::path::controlled_media_path;
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, FromQueryResult,
    IsolationLevel, Statement, TransactionTrait,
};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct MovieRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
    video_asset_id: Option<Uuid>,
    duration_seconds: Option<i32>,
}

#[derive(FromQueryResult)]
struct SeriesRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
}

#[derive(FromQueryResult)]
struct EpisodeRow {
    series_id: Uuid,
    season_number: i32,
    episode_number: i32,
    name: String,
    video_asset_id: Option<Uuid>,
    duration_seconds: Option<i32>,
}

#[derive(FromQueryResult)]
struct MediaRow {
    id: Uuid,
    storage_key: String,
}

#[derive(FromQueryResult)]
struct GenreRow {
    content_id: Uuid,
    name: String,
}

pub async fn export(db: &DatabaseConnection, exported_at: String) -> Result<ContentExport, DbErr> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let movies = MovieRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT movie.id, movie.name, movie.synopsis, movie.year, movie.poster_asset_id, movie.video_asset_id, movie.duration_seconds FROM movie ORDER BY movie.name ASC, movie.id ASC",
    )).all(&tx).await?;
    let series = SeriesRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT series.id, series.name, series.synopsis, series.year, series.poster_asset_id FROM series ORDER BY series.name ASC, series.id ASC",
    )).all(&tx).await?;
    let movie_genres = GenreRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT movie_genre.movie_id AS content_id, genre.name FROM movie_genre JOIN genre ON genre.id = movie_genre.genre_id ORDER BY movie_genre.movie_id ASC, genre.sort_order ASC, genre.id ASC",
    )).all(&tx).await?;
    let series_genres = GenreRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT series_genre.series_id AS content_id, genre.name FROM series_genre JOIN genre ON genre.id = series_genre.genre_id ORDER BY series_genre.series_id ASC, genre.sort_order ASC, genre.id ASC",
    )).all(&tx).await?;
    let episodes = EpisodeRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT season.series_id, season.number AS season_number, episode.number AS episode_number, episode.name, episode.video_asset_id, episode.duration_seconds FROM episode JOIN season ON season.id = episode.season_id ORDER BY series_id ASC, season.number ASC, episode.number ASC, episode.id ASC",
    )).all(&tx).await?;
    let media = tx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
SELECT media_asset.id, media_asset.storage_key FROM media_asset
WHERE media_asset.id IN (
    SELECT poster_asset_id FROM movie
    UNION ALL SELECT video_asset_id FROM movie
    UNION ALL SELECT poster_asset_id FROM series
    UNION ALL SELECT video_asset_id FROM episode
)
"#,
        ))
        .await?
        .iter()
        .map(|row| {
            let media = MediaRow::from_query_result(row, "")?;
            Ok((media.id, media.storage_key))
        })
        .collect::<Result<HashMap<_, _>, DbErr>>()?;

    let mut movie_genres = group_genres(movie_genres);
    let movies = movies
        .into_iter()
        .map(|row| {
            Ok(ExportMovie {
                name: row.name,
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

fn group_genres(rows: Vec<GenreRow>) -> HashMap<Uuid, Vec<String>> {
    let mut grouped: HashMap<Uuid, Vec<String>> = HashMap::new();
    for row in rows {
        grouped.entry(row.content_id).or_default().push(row.name);
    }
    grouped
}

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
