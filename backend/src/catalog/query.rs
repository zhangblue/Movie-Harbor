use super::dto::{
    CatalogCard, CatalogFilter, CatalogPage, MovieDetail, PublicEpisode, PublicGenre, PublicSeason,
    SeriesDetail, media_url, public_genre, published_at_string,
};
use chrono::{DateTime, FixedOffset};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, FromQueryResult,
    IsolationLevel, QueryResult, Statement, TransactionTrait, Value,
};
use std::collections::HashMap;
use uuid::Uuid;

const CATALOG_COUNT_SQL: &str = r#"
SELECT count(*)::bigint AS total
FROM (
    SELECT movie.id
    FROM movie
    WHERE $1::text IN ('all', 'movie')
      AND movie.status = 'published'
      AND movie.published_at IS NOT NULL
    UNION ALL
    SELECT series.id
    FROM series
    WHERE $1::text IN ('all', 'series')
      AND series.status = 'published'
      AND series.published_at IS NOT NULL
) candidates
"#;

const CATALOG_SEARCH_COUNT_SQL: &str = r#"
SELECT count(*)::bigint AS total
FROM (
    SELECT movie.id
    FROM movie
    WHERE $1::text IN ('all', 'movie')
      AND movie.status = 'published'
      AND movie.published_at IS NOT NULL
      AND lower(movie.name) LIKE lower($2::text) ESCAPE '!'
    UNION ALL
    SELECT movie.id
    FROM movie
    WHERE $1::text IN ('all', 'movie')
      AND movie.status = 'published'
      AND movie.published_at IS NOT NULL
      AND lower(movie.synopsis) LIKE lower($2::text) ESCAPE '!'
      AND lower(movie.name) NOT LIKE lower($2::text) ESCAPE '!'
    UNION ALL
    SELECT series.id
    FROM series
    WHERE $1::text IN ('all', 'series')
      AND series.status = 'published'
      AND series.published_at IS NOT NULL
      AND lower(series.name) LIKE lower($2::text) ESCAPE '!'
    UNION ALL
    SELECT series.id
    FROM series
    WHERE $1::text IN ('all', 'series')
      AND series.status = 'published'
      AND series.published_at IS NOT NULL
      AND lower(series.synopsis) LIKE lower($2::text) ESCAPE '!'
      AND lower(series.name) NOT LIKE lower($2::text) ESCAPE '!'
) candidates
"#;

/// Kept visible for integration-level EXPLAIN verification against the exact production query.
pub const CATALOG_ITEMS_SQL: &str = r#"
WITH candidates AS (
    SELECT * FROM (
        SELECT movie.id, 'movie'::text AS kind, movie.name, movie.year,
               movie.poster_asset_id, movie.published_at
        FROM movie
        WHERE $1::text IN ('all', 'movie')
          AND movie.status = 'published'
          AND movie.published_at IS NOT NULL
        ORDER BY published_at DESC, id
        LIMIT $4
    ) movie_candidates
    UNION ALL
    SELECT * FROM (
        SELECT series.id, 'series'::text AS kind, series.name, series.year,
               series.poster_asset_id, series.published_at
        FROM series
        WHERE $1::text IN ('all', 'series')
          AND series.status = 'published'
          AND series.published_at IS NOT NULL
        ORDER BY published_at DESC, id
        LIMIT $4
    ) series_candidates
), page AS MATERIALIZED (
    SELECT * FROM candidates
    ORDER BY published_at DESC, kind, id
    LIMIT $2 OFFSET $3
)
SELECT page.id, page.kind, page.name, page.year, page.published_at,
       poster.storage_volume AS poster_storage_volume,
       poster.storage_key AS poster_storage_key
FROM page
LEFT JOIN media_asset poster ON poster.id = page.poster_asset_id
ORDER BY page.published_at DESC, page.kind, page.id
"#;

/// Search variant of the production query, exposed for integration-level EXPLAIN verification.
pub const CATALOG_SEARCH_ITEMS_SQL: &str = r#"
WITH candidates AS (
    SELECT * FROM (
        SELECT * FROM (
            SELECT movie.id, 'movie'::text AS kind, movie.name, movie.year,
                   movie.poster_asset_id, movie.published_at
            FROM movie
            WHERE $1::text IN ('all', 'movie')
              AND movie.status = 'published'
              AND movie.published_at IS NOT NULL
              AND lower(movie.name) LIKE lower($2::text) ESCAPE '!'
            UNION ALL
            SELECT movie.id, 'movie'::text AS kind, movie.name, movie.year,
                   movie.poster_asset_id, movie.published_at
            FROM movie
            WHERE $1::text IN ('all', 'movie')
              AND movie.status = 'published'
              AND movie.published_at IS NOT NULL
              AND lower(movie.synopsis) LIKE lower($2::text) ESCAPE '!'
              AND lower(movie.name) NOT LIKE lower($2::text) ESCAPE '!'
        ) movie_matches
        ORDER BY published_at DESC, id
        LIMIT $5
    ) movie_candidates
    UNION ALL
    SELECT * FROM (
        SELECT * FROM (
            SELECT series.id, 'series'::text AS kind, series.name, series.year,
                   series.poster_asset_id, series.published_at
            FROM series
            WHERE $1::text IN ('all', 'series')
              AND series.status = 'published'
              AND series.published_at IS NOT NULL
              AND lower(series.name) LIKE lower($2::text) ESCAPE '!'
            UNION ALL
            SELECT series.id, 'series'::text AS kind, series.name, series.year,
                   series.poster_asset_id, series.published_at
            FROM series
            WHERE $1::text IN ('all', 'series')
              AND series.status = 'published'
              AND series.published_at IS NOT NULL
              AND lower(series.synopsis) LIKE lower($2::text) ESCAPE '!'
              AND lower(series.name) NOT LIKE lower($2::text) ESCAPE '!'
        ) series_matches
        ORDER BY published_at DESC, id
        LIMIT $5
    ) series_candidates
), page AS MATERIALIZED (
    SELECT * FROM candidates
    ORDER BY published_at DESC, kind, id
    LIMIT $3 OFFSET $4
)
SELECT page.id, page.kind, page.name, page.year, page.published_at,
       poster.storage_volume AS poster_storage_volume,
       poster.storage_key AS poster_storage_key
FROM page
LEFT JOIN media_asset poster ON poster.id = page.poster_asset_id
ORDER BY page.published_at DESC, page.kind, page.id
"#;

const MOVIE_DETAIL_SQL: &str = r#"
SELECT movie.id, movie.name, movie.synopsis, movie.year, movie.duration_seconds,
       poster.storage_volume AS poster_storage_volume,
       poster.storage_key AS poster_storage_key,
       video.storage_volume AS video_storage_volume,
       video.storage_key AS video_storage_key
FROM movie
LEFT JOIN media_asset poster ON poster.id = movie.poster_asset_id
LEFT JOIN media_asset video ON video.id = movie.video_asset_id
WHERE movie.id = $1
  AND movie.status = 'published'
  AND movie.published_at IS NOT NULL
"#;

const SERIES_DETAIL_SQL: &str = r#"
SELECT series.id, series.name, series.synopsis, series.year,
       poster.storage_volume AS poster_storage_volume,
       poster.storage_key AS poster_storage_key
FROM series
LEFT JOIN media_asset poster ON poster.id = series.poster_asset_id
WHERE series.id = $1
  AND series.status = 'published'
  AND series.published_at IS NOT NULL
"#;

const SERIES_EPISODES_SQL: &str = r#"
SELECT season.id AS season_id, season.number AS season_number,
       episode.id, episode.number, episode.name, episode.duration_seconds,
       video.storage_volume AS video_storage_volume,
       video.storage_key AS video_storage_key
FROM season
JOIN series parent ON parent.id = season.series_id
                  AND parent.status = 'published'
                  AND parent.published_at IS NOT NULL
JOIN episode ON episode.season_id = season.id
            AND episode.status = 'published'
            AND episode.published_at IS NOT NULL
LEFT JOIN media_asset video ON video.id = episode.video_asset_id
WHERE season.series_id = $1
ORDER BY season.number, season.id, episode.number, episode.id
"#;

#[derive(Debug, FromQueryResult)]
struct CatalogRow {
    id: Uuid,
    kind: String,
    name: String,
    year: Option<i32>,
    published_at: DateTime<FixedOffset>,
    poster_storage_volume: Option<i32>,
    poster_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct MovieRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    duration_seconds: Option<i32>,
    poster_storage_volume: Option<i32>,
    poster_storage_key: Option<String>,
    video_storage_volume: Option<i32>,
    video_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct SeriesRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_storage_volume: Option<i32>,
    poster_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct EpisodeRow {
    season_id: Uuid,
    season_number: i32,
    id: Uuid,
    number: i32,
    name: String,
    duration_seconds: Option<i32>,
    video_storage_volume: Option<i32>,
    video_storage_key: Option<String>,
}

struct GenreRow {
    content_kind: String,
    content_id: Uuid,
    genre_id: Uuid,
    name: String,
}

impl GenreRow {
    fn from_query_result(row: &QueryResult) -> Result<Self, DbErr> {
        Ok(Self {
            content_kind: row.try_get("", "content_kind")?,
            content_id: row.try_get("", "content_id")?,
            genre_id: row.try_get("", "genre_id")?,
            name: row.try_get("", "name")?,
        })
    }
}

pub async fn list(db: &DatabaseConnection, filter: CatalogFilter) -> Result<CatalogPage, DbErr> {
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let page = list_on(&transaction, filter).await?;
    transaction.commit().await?;
    Ok(page)
}

async fn list_on<C: ConnectionTrait>(db: &C, filter: CatalogFilter) -> Result<CatalogPage, DbErr> {
    let kind_value = || filter.kind.as_str().into();
    let (count_sql, count_values) = match &filter.search_pattern {
        Some(pattern) => (
            CATALOG_SEARCH_COUNT_SQL,
            vec![kind_value(), pattern.clone().into()],
        ),
        None => (CATALOG_COUNT_SQL, vec![kind_value()]),
    };
    let total_row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            count_sql,
            count_values,
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("catalog count returned no row".into()))?;
    let total = u64::try_from(total_row.try_get::<i64>("", "total")?)
        .map_err(|_| DbErr::Custom("catalog count was negative".into()))?;

    let (items_sql, values) = match &filter.search_pattern {
        Some(pattern) => (
            CATALOG_SEARCH_ITEMS_SQL,
            vec![
                kind_value(),
                pattern.clone().into(),
                i64::try_from(filter.size).unwrap().into(),
                i64::try_from(filter.offset).unwrap().into(),
                i64::try_from(filter.window).unwrap().into(),
            ],
        ),
        None => (
            CATALOG_ITEMS_SQL,
            vec![
                kind_value(),
                i64::try_from(filter.size).unwrap().into(),
                i64::try_from(filter.offset).unwrap().into(),
                i64::try_from(filter.window).unwrap().into(),
            ],
        ),
    };
    let rows = query_models::<CatalogRow>(db, items_sql, values).await?;
    let references = rows
        .iter()
        .map(|row| (row.kind.as_str(), row.id))
        .collect::<Vec<_>>();
    let mut genres = genres_for(db, &references).await?;
    let items = rows
        .into_iter()
        .map(|row| {
            let all_genres = genres
                .remove(&(row.kind.clone(), row.id))
                .unwrap_or_default();
            let genre_count = all_genres.len();
            CatalogCard {
                id: row.id.to_string(),
                kind: row.kind,
                name: row.name,
                year: row.year,
                poster_url: media_url(row.poster_storage_volume, row.poster_storage_key, "poster"),
                published_at: published_at_string(row.published_at),
                genres: all_genres.into_iter().take(3).collect(),
                genre_count,
            }
        })
        .collect();
    Ok(CatalogPage {
        page: filter.page,
        size: filter.size,
        total,
        items,
    })
}

pub async fn movie_detail(db: &DatabaseConnection, id: Uuid) -> Result<Option<MovieDetail>, DbErr> {
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let detail = movie_detail_on(&transaction, id).await?;
    transaction.commit().await?;
    Ok(detail)
}

async fn movie_detail_on<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> Result<Option<MovieDetail>, DbErr> {
    let Some(row) = query_model::<MovieRow>(db, MOVIE_DETAIL_SQL, vec![id.into()]).await? else {
        return Ok(None);
    };
    let mut genres = genres_for(db, &[("movie", id)]).await?;
    Ok(Some(MovieDetail {
        id: row.id.to_string(),
        kind: "movie",
        name: row.name,
        synopsis: row.synopsis,
        year: row.year,
        duration_seconds: row.duration_seconds,
        poster_url: media_url(row.poster_storage_volume, row.poster_storage_key, "poster"),
        video_url: media_url(row.video_storage_volume, row.video_storage_key, "video"),
        genres: genres.remove(&("movie".into(), id)).unwrap_or_default(),
    }))
}

pub async fn series_detail(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<SeriesDetail>, DbErr> {
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let detail = series_detail_on(&transaction, id).await?;
    transaction.commit().await?;
    Ok(detail)
}

async fn series_detail_on<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> Result<Option<SeriesDetail>, DbErr> {
    let Some(row) = query_model::<SeriesRow>(db, SERIES_DETAIL_SQL, vec![id.into()]).await? else {
        return Ok(None);
    };
    let mut genres = genres_for(db, &[("series", id)]).await?;
    let episode_rows = query_models::<EpisodeRow>(db, SERIES_EPISODES_SQL, vec![id.into()]).await?;
    let mut seasons = Vec::<PublicSeason>::new();
    for episode in episode_rows {
        if seasons
            .last()
            .is_none_or(|season| season.id != episode.season_id.to_string())
        {
            seasons.push(PublicSeason {
                id: episode.season_id.to_string(),
                number: episode.season_number,
                episodes: Vec::new(),
            });
        }
        seasons.last_mut().unwrap().episodes.push(PublicEpisode {
            id: episode.id.to_string(),
            number: episode.number,
            name: episode.name,
            duration_seconds: episode.duration_seconds,
            video_url: media_url(
                episode.video_storage_volume,
                episode.video_storage_key,
                "video",
            ),
        });
    }
    Ok(Some(SeriesDetail {
        id: row.id.to_string(),
        kind: "series",
        name: row.name,
        synopsis: row.synopsis,
        year: row.year,
        poster_url: media_url(row.poster_storage_volume, row.poster_storage_key, "poster"),
        genres: genres.remove(&("series".into(), id)).unwrap_or_default(),
        seasons,
    }))
}

async fn query_models<T: FromQueryResult>(
    db: &impl ConnectionTrait,
    sql: &str,
    values: Vec<Value>,
) -> Result<Vec<T>, DbErr> {
    db.query_all(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await?
    .iter()
    .map(|row| T::from_query_result(row, ""))
    .collect()
}

async fn query_model<T: FromQueryResult>(
    db: &impl ConnectionTrait,
    sql: &str,
    values: Vec<Value>,
) -> Result<Option<T>, DbErr> {
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await?
    .as_ref()
    .map(|row| T::from_query_result(row, ""))
    .transpose()
}

async fn genres_for(
    db: &impl ConnectionTrait,
    references: &[(&str, Uuid)],
) -> Result<HashMap<(String, Uuid), Vec<PublicGenre>>, DbErr> {
    if references.is_empty() {
        return Ok(HashMap::new());
    }
    let mut placeholders = Vec::with_capacity(references.len());
    let mut values = Vec::with_capacity(references.len() * 2);
    for (index, (kind, id)) in references.iter().enumerate() {
        let first = index * 2 + 1;
        placeholders.push(format!("(${first}::text, ${}::uuid)", first + 1));
        values.push((*kind).into());
        values.push((*id).into());
    }
    let sql = format!(
        r#"
WITH requested(kind, id) AS (VALUES {})
SELECT 'movie'::text AS content_kind, movie_genre.movie_id AS content_id,
       genre.id AS genre_id, genre.name, genre.sort_order
FROM requested
JOIN movie_genre ON requested.kind = 'movie' AND movie_genre.movie_id = requested.id
JOIN genre ON genre.id = movie_genre.genre_id
UNION ALL
SELECT 'series'::text AS content_kind, series_genre.series_id AS content_id,
       genre.id AS genre_id, genre.name, genre.sort_order
FROM requested
JOIN series_genre ON requested.kind = 'series' AND series_genre.series_id = requested.id
JOIN genre ON genre.id = series_genre.genre_id
ORDER BY content_kind, content_id, sort_order, genre_id
"#,
        placeholders.join(", ")
    );
    let mut result = HashMap::<(String, Uuid), Vec<PublicGenre>>::new();
    for row in db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await?
    {
        let row = GenreRow::from_query_result(&row)?;
        result
            .entry((row.content_kind, row.content_id))
            .or_default()
            .push(public_genre(row.genre_id, row.name));
    }
    Ok(result)
}
