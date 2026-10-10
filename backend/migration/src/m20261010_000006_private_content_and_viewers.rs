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
ALTER TABLE movie ADD COLUMN is_private boolean NOT NULL DEFAULT false;
ALTER TABLE series ADD COLUMN is_private boolean NOT NULL DEFAULT false;
CREATE TABLE viewer_user (
  id uuid PRIMARY KEY,
  username text NOT NULL CHECK (length(btrim(username)) > 0),
  normalized_username text NOT NULL UNIQUE CHECK (length(normalized_username) > 0),
  password_hash text NOT NULL,
  last_login_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE viewer_session (
  id uuid PRIMARY KEY,
  viewer_user_id uuid NOT NULL REFERENCES viewer_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX viewer_session_user_idx ON viewer_session(viewer_user_id);
CREATE INDEX viewer_session_expiry_idx ON viewer_session(expires_at);
CREATE INDEX movie_public_catalog_idx ON movie (published_at DESC, id) WHERE status = 'published' AND is_private = false;
CREATE INDEX series_public_catalog_idx ON series (published_at DESC, id) WHERE status = 'published' AND is_private = false;
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
DROP INDEX series_public_catalog_idx;
DROP INDEX movie_public_catalog_idx;
DROP INDEX viewer_session_expiry_idx;
DROP INDEX viewer_session_user_idx;
DROP TABLE viewer_session;
DROP TABLE viewer_user;
ALTER TABLE series DROP COLUMN is_private;
ALTER TABLE movie DROP COLUMN is_private;
"#,
            )
            .await?;
        Ok(())
    }
}
