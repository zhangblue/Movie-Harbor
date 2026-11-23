use super::dto::{AssetCounts, LifecycleCounts, OverviewCounts};
use sea_orm::{ConnectionTrait, DbErr, FromQueryResult, Statement};

#[derive(Debug, FromQueryResult)]
/// 承载单条聚合语句返回的数据库系统摘要。
struct SummaryRow {
    movie_draft: i64,
    movie_published: i64,
    movie_archived: i64,
    series_draft: i64,
    series_published: i64,
    series_archived: i64,
    episode_draft: i64,
    episode_published: i64,
    episode_archived: i64,
    viewer_users: i64,
    active_viewer_users: i64,
    poster_count: i64,
    poster_bytes: i64,
    video_count: i64,
    video_bytes: i64,
}

/// 将数据库聚合值转换为非负响应数值，拒绝不可能的负数。
fn count(value: i64) -> Result<u64, DbErr> {
    u64::try_from(value).map_err(|_| DbErr::Custom("system overview count was negative".into()))
}

/// 在调用方的一致性事务中读取所有内容、用户和媒体摘要。
pub async fn summary<C: ConnectionTrait>(db: &C) -> Result<OverviewCounts, DbErr> {
    // 单条聚合语句避免分项查询在同一快照内仍产生不必要的往返，也使失败保持全有或全无。
    let statement = Statement::from_string(
        db.get_database_backend(),
        r#"
SELECT
  (SELECT count(*) FILTER (WHERE status = 'draft') FROM movie) AS movie_draft,
  (SELECT count(*) FILTER (WHERE status = 'published') FROM movie) AS movie_published,
  (SELECT count(*) FILTER (WHERE status = 'archived') FROM movie) AS movie_archived,
  (SELECT count(*) FILTER (WHERE status = 'draft') FROM series) AS series_draft,
  (SELECT count(*) FILTER (WHERE status = 'published') FROM series) AS series_published,
  (SELECT count(*) FILTER (WHERE status = 'archived') FROM series) AS series_archived,
  (SELECT count(*) FILTER (WHERE status = 'draft') FROM episode) AS episode_draft,
  (SELECT count(*) FILTER (WHERE status = 'published') FROM episode) AS episode_published,
  (SELECT count(*) FILTER (WHERE status = 'archived') FROM episode) AS episode_archived,
  (SELECT count(*) FROM viewer_user) AS viewer_users,
  (SELECT count(DISTINCT viewer_user_id) FROM viewer_session WHERE expires_at > now()) AS active_viewer_users,
  (SELECT count(*) FILTER (WHERE purpose = 'poster') FROM media_asset) AS poster_count,
  (SELECT COALESCE(sum(byte_size) FILTER (WHERE purpose = 'poster'), 0)::bigint FROM media_asset) AS poster_bytes,
  (SELECT count(*) FILTER (WHERE purpose = 'video') FROM media_asset) AS video_count,
  (SELECT COALESCE(sum(byte_size) FILTER (WHERE purpose = 'video'), 0)::bigint FROM media_asset) AS video_bytes
"#,
    );
    let row = SummaryRow::find_by_statement(statement)
        .one(db)
        .await?
        .ok_or_else(|| DbErr::Custom("system overview summary returned no row".into()))?;
    Ok(OverviewCounts {
        movies: LifecycleCounts {
            draft: count(row.movie_draft)?,
            published: count(row.movie_published)?,
            archived: count(row.movie_archived)?,
        },
        series: LifecycleCounts {
            draft: count(row.series_draft)?,
            published: count(row.series_published)?,
            archived: count(row.series_archived)?,
        },
        episodes: LifecycleCounts {
            draft: count(row.episode_draft)?,
            published: count(row.episode_published)?,
            archived: count(row.episode_archived)?,
        },
        viewer_users: count(row.viewer_users)?,
        active_viewer_users: count(row.active_viewer_users)?,
        posters: AssetCounts {
            count: count(row.poster_count)?,
            bytes: count(row.poster_bytes)?,
        },
        videos: AssetCounts {
            count: count(row.video_count)?,
            bytes: count(row.video_bytes)?,
        },
    })
}
