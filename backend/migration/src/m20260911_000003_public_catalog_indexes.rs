use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
-- Extension installation is database-global while isolated-schema integration tests run
-- migrations concurrently against one database.
SELECT pg_advisory_xact_lock(73194728560311);
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX movie_public_published_idx
    ON movie (published_at DESC, id)
    INCLUDE (name, year, poster_asset_id)
    WHERE status = 'published' AND published_at IS NOT NULL;
CREATE INDEX series_public_published_idx
    ON series (published_at DESC, id)
    INCLUDE (name, year, poster_asset_id)
    WHERE status = 'published' AND published_at IS NOT NULL;
CREATE INDEX episode_public_season_idx
    ON episode (season_id, number, id)
    WHERE status = 'published' AND published_at IS NOT NULL;

CREATE INDEX movie_name_search_idx
    ON movie USING gin (lower(name) public.gin_trgm_ops)
    WHERE status = 'published' AND published_at IS NOT NULL;
CREATE INDEX movie_synopsis_search_idx
    ON movie USING gin (lower(synopsis) public.gin_trgm_ops)
    WHERE status = 'published' AND published_at IS NOT NULL;
CREATE INDEX series_name_search_idx
    ON series USING gin (lower(name) public.gin_trgm_ops)
    WHERE status = 'published' AND published_at IS NOT NULL;
CREATE INDEX series_synopsis_search_idx
    ON series USING gin (lower(synopsis) public.gin_trgm_ops)
    WHERE status = 'published' AND published_at IS NOT NULL;

CREATE INDEX movie_poster_asset_idx ON movie (poster_asset_id);
CREATE INDEX movie_video_asset_idx ON movie (video_asset_id);
CREATE INDEX series_poster_asset_idx ON series (poster_asset_id);
CREATE INDEX episode_video_asset_idx ON episode (video_asset_id);
CREATE INDEX movie_genre_genre_idx ON movie_genre (genre_id);
CREATE INDEX series_genre_genre_idx ON series_genre (genre_id);
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
DROP INDEX IF EXISTS series_genre_genre_idx;
DROP INDEX IF EXISTS movie_genre_genre_idx;
DROP INDEX IF EXISTS episode_video_asset_idx;
DROP INDEX IF EXISTS series_poster_asset_idx;
DROP INDEX IF EXISTS movie_video_asset_idx;
DROP INDEX IF EXISTS movie_poster_asset_idx;
DROP INDEX IF EXISTS series_synopsis_search_idx;
DROP INDEX IF EXISTS series_name_search_idx;
DROP INDEX IF EXISTS movie_synopsis_search_idx;
DROP INDEX IF EXISTS movie_name_search_idx;
DROP INDEX IF EXISTS episode_public_season_idx;
DROP INDEX IF EXISTS series_public_published_idx;
DROP INDEX IF EXISTS movie_public_published_idx;
"#,
            )
            .await?;
        Ok(())
    }
}
