use super::dto::{
    CursorInput, CursorRecord, MergeItemResult, MergeStatus, PlaybackTargetKind, ProgressInput,
    ProgressMergeInput, ProgressRecord, ProgressSnapshot, RemovalInput, RemovalTargetKind,
};
use crate::entities::{viewer_playback_progress, viewer_playback_removal, viewer_series_cursor};
use chrono::Utc;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, Statement,
};
use uuid::Uuid;

/// 表示进度输入无效、目标不可见或数据库失败，供路由映射稳定响应。
pub enum ServiceError {
    Invalid,
    NotFound,
    Database,
}

impl From<sea_orm::DbErr> for ServiceError {
    /// 将数据库错误保留到服务错误中，供路由统一映射为内部错误。
    fn from(_: sea_orm::DbErr) -> Self {
        Self::Database
    }
}

/// 校验客户端时间和播放数值，供单条与批量进度写入共享。
fn validate_progress(input: &ProgressInput) -> Result<(), ServiceError> {
    if !input.position_seconds.is_finite()
        || !input.duration_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.duration_seconds <= 0.0
        || input.position_seconds > input.duration_seconds
        || input.updated_at > (Utc::now() + chrono::Duration::hours(24)).fixed_offset()
    {
        return Err(ServiceError::Invalid);
    }
    Ok(())
}

/// 查询单集所属的有效发布剧集，供进度、游标和快照隐藏不可播放目标。
async fn playable_episode<C: ConnectionTrait>(
    db: &C,
    episode_id: Uuid,
) -> Result<Option<Uuid>, sea_orm::DbErr> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            r#"SELECT s.id AS series_id
FROM episode e
JOIN season se ON se.id=e.season_id
JOIN series s ON s.id=se.series_id
WHERE e.id=$1 AND e.status='published' AND e.video_asset_id IS NOT NULL AND s.status='published'"#,
            [episode_id.into()],
        ))
        .await?;
    row.map(|row| row.try_get("", "series_id")).transpose()
}

/// 判断电影当前是否可由普通用户播放，供写入和快照过滤。
async fn playable_movie<C: ConnectionTrait>(
    db: &C,
    movie_id: Uuid,
) -> Result<bool, sea_orm::DbErr> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "SELECT EXISTS (SELECT 1 FROM movie WHERE id=$1 AND status='published' AND video_asset_id IS NOT NULL) AS playable",
            [movie_id.into()],
        ))
        .await?
        .expect("EXISTS always returns one row");
    row.try_get("", "playable")
}

/// 判断删除目标是否仍是普通用户可见的有效发布内容，避免泄露隐藏目标存在性。
async fn removable_target<C: ConnectionTrait>(
    db: &C,
    kind: RemovalTargetKind,
    id: Uuid,
) -> Result<bool, sea_orm::DbErr> {
    if kind == RemovalTargetKind::Movie {
        return playable_movie(db, id).await;
    }
    if kind == RemovalTargetKind::Episode {
        return Ok(playable_episode(db, id).await?.is_some());
    }
    let row = db
        .query_one(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            r#"SELECT EXISTS (
SELECT 1 FROM series s
JOIN season se ON se.series_id=s.id
JOIN episode e ON e.season_id=se.id
WHERE s.id=$1 AND s.status='published' AND e.status='published' AND e.video_asset_id IS NOT NULL
) AS present"#,
            [id.into()],
        ))
        .await?
        .expect("EXISTS always returns one row");
    row.try_get("", "present")
}

/// 读取适用于目标的最新墓碑时间，供写入和快照忽略离线旧记录。
async fn latest_removal<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
    kind: PlaybackTargetKind,
    id: Uuid,
    series_id: Option<Uuid>,
) -> Result<Option<chrono::DateTime<chrono::FixedOffset>>, sea_orm::DbErr> {
    let target = match kind {
        PlaybackTargetKind::Movie => {
            Condition::any().add(viewer_playback_removal::Column::MovieId.eq(id))
        }
        PlaybackTargetKind::Episode => {
            let mut condition =
                Condition::any().add(viewer_playback_removal::Column::EpisodeId.eq(id));
            if let Some(series_id) = series_id {
                condition = condition.add(viewer_playback_removal::Column::SeriesId.eq(series_id));
            }
            condition
        }
    };
    Ok(viewer_playback_removal::Entity::find()
        .filter(viewer_playback_removal::Column::ViewerUserId.eq(viewer_id))
        .filter(target)
        .order_by_desc(viewer_playback_removal::Column::RemovedAt)
        .one(db)
        .await?
        .map(|record| record.removed_at))
}

/// 读取整剧最新墓碑，供游标写入和规范快照过滤。
async fn latest_series_removal<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
    series_id: Uuid,
) -> Result<Option<chrono::DateTime<chrono::FixedOffset>>, sea_orm::DbErr> {
    Ok(viewer_playback_removal::Entity::find()
        .filter(viewer_playback_removal::Column::ViewerUserId.eq(viewer_id))
        .filter(viewer_playback_removal::Column::SeriesId.eq(series_id))
        .one(db)
        .await?
        .map(|record| record.removed_at))
}

/// 写入一条较新的电影或单集进度，供单条 PUT 与批量合并复用。
pub async fn put_progress<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
    kind: PlaybackTargetKind,
    id: Uuid,
    input: ProgressInput,
) -> Result<MergeStatus, ServiceError> {
    validate_progress(&input)?;
    let series_id = match kind {
        PlaybackTargetKind::Movie => {
            if !playable_movie(db, id).await? {
                return Err(ServiceError::NotFound);
            }
            None
        }
        PlaybackTargetKind::Episode => {
            let Some(series_id) = playable_episode(db, id).await? else {
                return Err(ServiceError::NotFound);
            };
            Some(series_id)
        }
    };
    if latest_removal(db, viewer_id, kind, id, series_id)
        .await?
        .is_some_and(|removed_at| removed_at >= input.updated_at)
    {
        return Ok(MergeStatus::Ignored);
    }
    let (target_column, conflict_column) = match kind {
        PlaybackTargetKind::Movie => ("movie_id", "movie_id"),
        PlaybackTargetKind::Episode => ("episode_id", "episode_id"),
    };
    // 条件 upsert 让并发首次写入只有一个插入者，并由数据库原子保留较新的客户端时间。
    let result = db
        .execute(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            format!(
                r#"INSERT INTO viewer_playback_progress
  (id, viewer_user_id, {target_column}, position_seconds, duration_seconds, completed, client_updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (viewer_user_id, {conflict_column}) WHERE {conflict_column} IS NOT NULL
DO UPDATE SET position_seconds=EXCLUDED.position_seconds,
              duration_seconds=EXCLUDED.duration_seconds,
              completed=EXCLUDED.completed,
              client_updated_at=EXCLUDED.client_updated_at,
              updated_at=CURRENT_TIMESTAMP
WHERE viewer_playback_progress.client_updated_at < EXCLUDED.client_updated_at"#
            ),
            [
                Uuid::new_v4().into(),
                viewer_id.into(),
                id.into(),
                input.position_seconds.into(),
                input.duration_seconds.into(),
                input.completed.into(),
                input.updated_at.into(),
            ],
        ))
        .await?;
    Ok(if result.rows_affected() == 0 {
        MergeStatus::Ignored
    } else {
        MergeStatus::Accepted
    })
}

/// 写入较新的剧集游标并确认单集属于该有效剧集。
pub async fn put_cursor<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
    input: CursorInput,
) -> Result<MergeStatus, ServiceError> {
    if input.updated_at > (Utc::now() + chrono::Duration::hours(24)).fixed_offset() {
        return Err(ServiceError::Invalid);
    }
    if playable_episode(db, input.episode_id).await? != Some(input.series_id) {
        return Err(ServiceError::NotFound);
    }
    if latest_series_removal(db, viewer_id, input.series_id)
        .await?
        .is_some_and(|removed_at| removed_at >= input.updated_at)
    {
        return Ok(MergeStatus::Ignored);
    }
    let result = db
        .execute(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            r#"INSERT INTO viewer_series_cursor
  (viewer_user_id, series_id, episode_id, client_updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (viewer_user_id, series_id)
DO UPDATE SET episode_id=EXCLUDED.episode_id,
              client_updated_at=EXCLUDED.client_updated_at,
              updated_at=CURRENT_TIMESTAMP
WHERE viewer_series_cursor.client_updated_at < EXCLUDED.client_updated_at"#,
            [
                viewer_id.into(),
                input.series_id.into(),
                input.episode_id.into(),
                input.updated_at.into(),
            ],
        ))
        .await?;
    Ok(if result.rows_affected() == 0 {
        MergeStatus::Ignored
    } else {
        MergeStatus::Accepted
    })
}

/// 保存较新的删除墓碑并清理不晚于它的进度或游标。
pub async fn remove<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
    input: RemovalInput,
) -> Result<MergeStatus, ServiceError> {
    if input.removed_at > (Utc::now() + chrono::Duration::hours(24)).fixed_offset() {
        return Err(ServiceError::Invalid);
    }
    if !removable_target(db, input.kind, input.id).await? {
        return Err(ServiceError::NotFound);
    }
    let target_column = match input.kind {
        RemovalTargetKind::Movie => "movie_id",
        RemovalTargetKind::Episode => "episode_id",
        RemovalTargetKind::Series => "series_id",
    };
    let upsert = db
        .execute(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            format!(
                r#"INSERT INTO viewer_playback_removal
  (id, viewer_user_id, {target_column}, removed_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (viewer_user_id, {target_column}) WHERE {target_column} IS NOT NULL
DO UPDATE SET removed_at=EXCLUDED.removed_at, updated_at=CURRENT_TIMESTAMP
WHERE viewer_playback_removal.removed_at < EXCLUDED.removed_at"#
            ),
            [
                Uuid::new_v4().into(),
                viewer_id.into(),
                input.id.into(),
                input.removed_at.into(),
            ],
        ))
        .await?;
    if upsert.rows_affected() == 0 {
        return Ok(MergeStatus::Ignored);
    }
    let statement = match input.kind {
        RemovalTargetKind::Movie => Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "DELETE FROM viewer_playback_progress WHERE viewer_user_id=$1 AND movie_id=$2 AND client_updated_at <= $3",
            [viewer_id.into(), input.id.into(), input.removed_at.into()],
        ),
        RemovalTargetKind::Episode => Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "DELETE FROM viewer_playback_progress WHERE viewer_user_id=$1 AND episode_id=$2 AND client_updated_at <= $3",
            [viewer_id.into(), input.id.into(), input.removed_at.into()],
        ),
        RemovalTargetKind::Series => Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "DELETE FROM viewer_playback_progress p USING episode e, season se WHERE p.viewer_user_id=$1 AND p.episode_id=e.id AND e.season_id=se.id AND se.series_id=$2 AND p.client_updated_at <= $3",
            [viewer_id.into(), input.id.into(), input.removed_at.into()],
        ),
    };
    db.execute(statement).await?;
    if input.kind == RemovalTargetKind::Series {
        db.execute(Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "DELETE FROM viewer_series_cursor WHERE viewer_user_id=$1 AND series_id=$2 AND client_updated_at <= $3",
            [viewer_id.into(), input.id.into(), input.removed_at.into()],
        ))
        .await?;
    }
    Ok(MergeStatus::Accepted)
}

/// 读取当前用户仍可播放的规范进度与游标，供 GET 和写入响应使用。
pub async fn snapshot<C: ConnectionTrait>(
    db: &C,
    viewer_id: Uuid,
) -> Result<ProgressSnapshot, ServiceError> {
    let mut snapshot = ProgressSnapshot::default();
    let records = viewer_playback_progress::Entity::find()
        .filter(viewer_playback_progress::Column::ViewerUserId.eq(viewer_id))
        .order_by_desc(viewer_playback_progress::Column::ClientUpdatedAt)
        .order_by_asc(viewer_playback_progress::Column::Id)
        .all(db)
        .await?;
    for record in records {
        let (kind, id, series_id) = if let Some(id) = record.movie_id {
            if !playable_movie(db, id).await? {
                continue;
            }
            (PlaybackTargetKind::Movie, id, None)
        } else if let Some(id) = record.episode_id {
            let Some(series_id) = playable_episode(db, id).await? else {
                continue;
            };
            (PlaybackTargetKind::Episode, id, Some(series_id))
        } else {
            continue;
        };
        if latest_removal(db, viewer_id, kind, id, series_id)
            .await?
            .is_some_and(|removed_at| removed_at >= record.client_updated_at)
        {
            continue;
        }
        snapshot.progress.push(ProgressRecord {
            kind,
            id,
            series_id,
            position_seconds: record.position_seconds,
            duration_seconds: record.duration_seconds,
            completed: record.completed,
            updated_at: record.client_updated_at,
        });
    }
    for cursor in viewer_series_cursor::Entity::find()
        .filter(viewer_series_cursor::Column::ViewerUserId.eq(viewer_id))
        .order_by_desc(viewer_series_cursor::Column::ClientUpdatedAt)
        .all(db)
        .await?
    {
        if playable_episode(db, cursor.episode_id).await? == Some(cursor.series_id)
            && !latest_series_removal(db, viewer_id, cursor.series_id)
                .await?
                .is_some_and(|removed_at| removed_at >= cursor.client_updated_at)
        {
            snapshot.cursors.push(CursorRecord {
                series_id: cursor.series_id,
                episode_id: cursor.episode_id,
                updated_at: cursor.client_updated_at,
            });
        }
    }
    Ok(snapshot)
}

/// 将批量进度输入转换为单条写入结构，供路由循环复用。
pub fn split_progress(input: ProgressMergeInput) -> (PlaybackTargetKind, Uuid, ProgressInput) {
    (
        input.kind,
        input.id,
        ProgressInput {
            position_seconds: input.position_seconds,
            duration_seconds: input.duration_seconds,
            completed: input.completed,
            updated_at: input.updated_at,
        },
    )
}

/// 构造成功或忽略的逐项结果，供合并响应保持稳定结构。
pub fn result(operation: &'static str, id: Uuid, status: MergeStatus) -> MergeItemResult {
    MergeItemResult {
        operation,
        id,
        status,
        reason: None,
    }
}

/// 构造不可恢复旧目标的逐项拒绝结果，供批量继续处理其他条目。
pub fn rejected(operation: &'static str, id: Uuid) -> MergeItemResult {
    MergeItemResult {
        operation,
        id,
        status: MergeStatus::Rejected,
        reason: Some("not_found"),
    }
}
