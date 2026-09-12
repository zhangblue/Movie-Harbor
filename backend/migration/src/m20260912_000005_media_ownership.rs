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
-- Freeze every v4 writer before preflight and retain the locks through backfill/trigger install.
LOCK TABLE movie, series, episode, file_cleanup_job IN ACCESS EXCLUSIVE MODE;
-- Also serializes multiple migration runners and gives the upgrade-race test a deterministic seam.
SELECT pg_advisory_xact_lock(5568785899137351989);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM file_cleanup_job) THEN
    RAISE EXCEPTION 'pending media cleanup jobs must be resolved';
  END IF;
  IF EXISTS (
    SELECT media_asset_id FROM (
      SELECT poster_asset_id AS media_asset_id FROM movie WHERE poster_asset_id IS NOT NULL
      UNION ALL SELECT video_asset_id FROM movie WHERE video_asset_id IS NOT NULL
      UNION ALL SELECT poster_asset_id FROM series WHERE poster_asset_id IS NOT NULL
      UNION ALL SELECT video_asset_id FROM episode WHERE video_asset_id IS NOT NULL
    ) refs GROUP BY media_asset_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'shared media assets must be resolved';
  END IF;
END $$;

DROP TABLE file_cleanup_job;

CREATE TABLE media_asset_ownership (
  asset_id uuid PRIMARY KEY REFERENCES media_asset(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('movie', 'series', 'episode')),
  owner_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('poster', 'video')),
  UNIQUE (owner_kind, owner_id, slot)
);

INSERT INTO media_asset_ownership (asset_id, owner_kind, owner_id, slot)
SELECT poster_asset_id, 'movie', id, 'poster' FROM movie WHERE poster_asset_id IS NOT NULL
UNION ALL SELECT video_asset_id, 'movie', id, 'video' FROM movie WHERE video_asset_id IS NOT NULL
UNION ALL SELECT poster_asset_id, 'series', id, 'poster' FROM series WHERE poster_asset_id IS NOT NULL
UNION ALL SELECT video_asset_id, 'episode', id, 'video' FROM episode WHERE video_asset_id IS NOT NULL;

CREATE FUNCTION sync_movie_media_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM media_asset_ownership WHERE owner_kind = 'movie' AND owner_id = OLD.id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.poster_asset_id IS NOT NULL THEN
      INSERT INTO media_asset_ownership VALUES (NEW.poster_asset_id, 'movie', NEW.id, 'poster');
    END IF;
    IF NEW.video_asset_id IS NOT NULL THEN
      INSERT INTO media_asset_ownership VALUES (NEW.video_asset_id, 'movie', NEW.id, 'video');
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION sync_series_media_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM media_asset_ownership WHERE owner_kind = 'series' AND owner_id = OLD.id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.poster_asset_id IS NOT NULL THEN
    INSERT INTO media_asset_ownership VALUES (NEW.poster_asset_id, 'series', NEW.id, 'poster');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION sync_episode_media_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM media_asset_ownership WHERE owner_kind = 'episode' AND owner_id = OLD.id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.video_asset_id IS NOT NULL THEN
    INSERT INTO media_asset_ownership VALUES (NEW.video_asset_id, 'episode', NEW.id, 'video');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER movie_media_ownership_write AFTER INSERT OR UPDATE OF poster_asset_id, video_asset_id ON movie FOR EACH ROW EXECUTE FUNCTION sync_movie_media_ownership();
CREATE TRIGGER movie_media_ownership_delete AFTER DELETE ON movie FOR EACH ROW EXECUTE FUNCTION sync_movie_media_ownership();
CREATE TRIGGER series_media_ownership_write AFTER INSERT OR UPDATE OF poster_asset_id ON series FOR EACH ROW EXECUTE FUNCTION sync_series_media_ownership();
CREATE TRIGGER series_media_ownership_delete AFTER DELETE ON series FOR EACH ROW EXECUTE FUNCTION sync_series_media_ownership();
CREATE TRIGGER episode_media_ownership_write AFTER INSERT OR UPDATE OF video_asset_id ON episode FOR EACH ROW EXECUTE FUNCTION sync_episode_media_ownership();
CREATE TRIGGER episode_media_ownership_delete AFTER DELETE ON episode FOR EACH ROW EXECUTE FUNCTION sync_episode_media_ownership();
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
DROP TRIGGER movie_media_ownership_write ON movie;
DROP TRIGGER movie_media_ownership_delete ON movie;
DROP TRIGGER series_media_ownership_write ON series;
DROP TRIGGER series_media_ownership_delete ON series;
DROP TRIGGER episode_media_ownership_write ON episode;
DROP TRIGGER episode_media_ownership_delete ON episode;
DROP FUNCTION sync_movie_media_ownership();
DROP FUNCTION sync_series_media_ownership();
DROP FUNCTION sync_episode_media_ownership();
DROP TABLE media_asset_ownership;
CREATE TABLE file_cleanup_job (
    id uuid PRIMARY KEY,
    media_asset_id uuid NOT NULL UNIQUE REFERENCES media_asset(id) ON DELETE RESTRICT,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text,
    next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#,
            )
            .await?;
        Ok(())
    }
}
