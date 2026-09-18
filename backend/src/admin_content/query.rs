use super::dto::{ADMIN_CONTENT_PAGE_SIZE, AdminContentFilter, AdminContentItem, AdminContentPage};
use chrono::{DateTime, FixedOffset};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, FromQueryResult,
    IsolationLevel, Statement, TransactionTrait,
};
use uuid::Uuid;

// 电影和剧集先投影为同一结构，随后才能按统一筛选条件统计总数。
const ADMIN_CONTENT_COUNT_SQL: &str = r#"
WITH candidates AS (
    SELECT movie.id, 'movie'::text AS kind, movie.name, movie.status,
           movie.version, movie.created_at, movie.poster_asset_id
    FROM movie
    WHERE $1::text IN ('all', 'movie')
      AND ($2::text IS NULL OR movie.status = $2::text)
      AND ($3::text IS NULL OR lower(movie.name) LIKE lower($3::text) ESCAPE '!')
    UNION ALL
    SELECT series.id, 'series'::text AS kind, series.name, series.status,
           series.version, series.created_at, series.poster_asset_id
    FROM series
    WHERE $1::text IN ('all', 'series')
      AND ($2::text IS NULL OR series.status = $2::text)
      AND ($3::text IS NULL OR lower(series.name) LIKE lower($3::text) ESCAPE '!')
)
SELECT count(*)::bigint AS total
FROM candidates
"#;

pub const ADMIN_CONTENT_ITEMS_SQL: &str = r#"
WITH candidates AS (
    SELECT movie.id, 'movie'::text AS kind, movie.name, movie.status,
           movie.version, movie.created_at, movie.poster_asset_id
    FROM movie
    WHERE $1::text IN ('all', 'movie')
      AND ($2::text IS NULL OR movie.status = $2::text)
      AND ($3::text IS NULL OR lower(movie.name) LIKE lower($3::text) ESCAPE '!')
    UNION ALL
    SELECT series.id, 'series'::text AS kind, series.name, series.status,
           series.version, series.created_at, series.poster_asset_id
    FROM series
    WHERE $1::text IN ('all', 'series')
      AND ($2::text IS NULL OR series.status = $2::text)
      AND ($3::text IS NULL OR lower(series.name) LIKE lower($3::text) ESCAPE '!')
)
SELECT candidates.id, candidates.kind, candidates.name, candidates.status,
       candidates.version, candidates.created_at,
       poster.storage_key AS poster_storage_key
FROM candidates
LEFT JOIN media_asset poster ON poster.id = candidates.poster_asset_id
ORDER BY candidates.created_at DESC, candidates.kind ASC, candidates.id ASC
LIMIT $4 OFFSET $5
"#;

#[derive(Debug, FromQueryResult)]
struct AdminContentRow {
    id: Uuid,
    kind: String,
    name: String,
    status: String,
    version: i64,
    created_at: DateTime<FixedOffset>,
    poster_storage_key: Option<String>,
}

pub async fn list(
    db: &DatabaseConnection,
    filter: AdminContentFilter,
) -> Result<AdminContentPage, DbErr> {
    // 总数与当前页必须来自同一 RepeatableRead 快照，避免并发发布导致页码和条目不一致。
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    // 所有筛选值都作为绑定参数传入，名称中的通配符不会改变 SQL 的筛选结构。
    let total_row = transaction
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            ADMIN_CONTENT_COUNT_SQL,
            vec![
                filter.kind.clone().into(),
                filter.status.clone().into(),
                filter.name_pattern.clone().into(),
            ],
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("admin content count returned no row".into()))?;
    let total = u64::try_from(total_row.try_get::<i64>("", "total")?)
        .map_err(|_| DbErr::Custom("admin content count was negative".into()))?;
    // 用创建时间、内容类型和 ID 的稳定顺序分页，避免相同时间的记录在翻页时重排。
    let rows = transaction
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            ADMIN_CONTENT_ITEMS_SQL,
            vec![
                filter.kind.into(),
                filter.status.into(),
                filter.name_pattern.into(),
                i64::try_from(ADMIN_CONTENT_PAGE_SIZE).unwrap().into(),
                i64::try_from(filter.offset).unwrap().into(),
            ],
        ))
        .await?
        .iter()
        .map(|row| AdminContentRow::from_query_result(row, ""))
        .collect::<Result<Vec<_>, _>>()?;
    let items = rows
        .into_iter()
        .map(|row| AdminContentItem {
            id: row.id.to_string(),
            kind: row.kind,
            name: row.name,
            status: row.status,
            version: row.version,
            created_at: row.created_at.to_rfc3339(),
            poster_url: crate::catalog::dto::media_url(row.poster_storage_key, "poster"),
        })
        .collect();
    transaction.commit().await?;
    Ok(AdminContentPage {
        page: filter.page,
        size: ADMIN_CONTENT_PAGE_SIZE,
        total,
        items,
    })
}
