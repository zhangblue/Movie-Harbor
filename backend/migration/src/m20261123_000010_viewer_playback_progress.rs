use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
/// 注册普通用户观看进度迁移，供升级时创建跨设备同步所需结构。
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    /// 升级时创建进度、剧集游标和永久删除墓碑及其完整性约束。
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
CREATE TABLE viewer_playback_progress (
  id uuid PRIMARY KEY,
  viewer_user_id uuid NOT NULL REFERENCES viewer_user(id) ON DELETE CASCADE,
  movie_id uuid REFERENCES movie(id) ON DELETE CASCADE,
  episode_id uuid REFERENCES episode(id) ON DELETE CASCADE,
  position_seconds double precision NOT NULL,
  duration_seconds double precision NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  client_updated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(movie_id, episode_id) = 1),
  CHECK (
    position_seconds >= 0
    AND position_seconds < 'Infinity'::double precision
    AND duration_seconds > 0
    AND duration_seconds < 'Infinity'::double precision
    AND position_seconds <= duration_seconds
  )
);
CREATE UNIQUE INDEX viewer_progress_movie_unique
  ON viewer_playback_progress(viewer_user_id, movie_id) WHERE movie_id IS NOT NULL;
CREATE UNIQUE INDEX viewer_progress_episode_unique
  ON viewer_playback_progress(viewer_user_id, episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX viewer_progress_user_updated_idx
  ON viewer_playback_progress(viewer_user_id, client_updated_at DESC, id);

CREATE TABLE viewer_series_cursor (
  viewer_user_id uuid NOT NULL REFERENCES viewer_user(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  client_updated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (viewer_user_id, series_id)
);
CREATE INDEX viewer_series_cursor_episode_idx ON viewer_series_cursor(episode_id);

CREATE TABLE viewer_playback_removal (
  id uuid PRIMARY KEY,
  viewer_user_id uuid NOT NULL REFERENCES viewer_user(id) ON DELETE CASCADE,
  movie_id uuid REFERENCES movie(id) ON DELETE CASCADE,
  episode_id uuid REFERENCES episode(id) ON DELETE CASCADE,
  series_id uuid REFERENCES series(id) ON DELETE CASCADE,
  removed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(movie_id, episode_id, series_id) = 1)
);
CREATE UNIQUE INDEX viewer_removal_movie_unique
  ON viewer_playback_removal(viewer_user_id, movie_id) WHERE movie_id IS NOT NULL;
CREATE UNIQUE INDEX viewer_removal_episode_unique
  ON viewer_playback_removal(viewer_user_id, episode_id) WHERE episode_id IS NOT NULL;
CREATE UNIQUE INDEX viewer_removal_series_unique
  ON viewer_playback_removal(viewer_user_id, series_id) WHERE series_id IS NOT NULL;
CREATE INDEX viewer_removal_user_updated_idx
  ON viewer_playback_removal(viewer_user_id, removed_at DESC, id);
"#,
            )
            .await?;
        Ok(())
    }

    /// 回滚时移除观看进度结构，不修改普通用户或内容数据。
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
DROP TABLE viewer_playback_removal;
DROP TABLE viewer_series_cursor;
DROP TABLE viewer_playback_progress;
"#,
            )
            .await?;
        Ok(())
    }
}
