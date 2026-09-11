use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // PostgreSQL is the supported database. Keep its constraints alongside the columns.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
CREATE TABLE admin_user (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE admin_session (
    id uuid PRIMARY KEY,
    admin_user_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    csrf_token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX admin_session_admin_user_idx ON admin_session(admin_user_id);
CREATE TABLE genre (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
    sort_order integer NOT NULL DEFAULT 0,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE media_asset (
    id uuid PRIMARY KEY,
    storage_key text NOT NULL UNIQUE CHECK (length(storage_key) > 0),
    original_name text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    purpose text NOT NULL CHECK (purpose IN ('poster', 'video')),
    checksum_sha256 text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE movie (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    synopsis text NOT NULL DEFAULT '',
    year integer,
    duration_seconds integer CHECK (duration_seconds >= 0),
    poster_asset_id uuid REFERENCES media_asset(id) ON DELETE RESTRICT,
    video_asset_id uuid REFERENCES media_asset(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE series (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    synopsis text NOT NULL DEFAULT '',
    year integer,
    poster_asset_id uuid REFERENCES media_asset(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE season (
    id uuid PRIMARY KEY,
    series_id uuid NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    number integer NOT NULL CHECK (number > 0),
    UNIQUE (series_id, number)
);
CREATE TABLE episode (
    id uuid PRIMARY KEY,
    season_id uuid NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    number integer NOT NULL CHECK (number > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    synopsis text NOT NULL DEFAULT '',
    duration_seconds integer CHECK (duration_seconds >= 0),
    video_asset_id uuid REFERENCES media_asset(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (season_id, number)
);
CREATE TABLE movie_genre (
    movie_id uuid NOT NULL REFERENCES movie(id) ON DELETE CASCADE,
    genre_id uuid NOT NULL REFERENCES genre(id) ON DELETE RESTRICT,
    PRIMARY KEY (movie_id, genre_id)
);
CREATE TABLE series_genre (
    series_id uuid NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    genre_id uuid NOT NULL REFERENCES genre(id) ON DELETE RESTRICT,
    PRIMARY KEY (series_id, genre_id)
);
-- Retain the asset (and its controlled relative storage key) until file cleanup succeeds.
-- Content deletion/replacement can enqueue once per asset inside its transaction.
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

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(
            "DROP TABLE file_cleanup_job, movie_genre, series_genre, episode, season, series, movie, media_asset, genre, admin_session, admin_user;",
        ).await?;
        Ok(())
    }
}
