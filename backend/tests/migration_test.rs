use sea_orm::{
    ConnectionTrait, Database, DatabaseTransaction, DbBackend, Statement, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use uuid::Uuid;

const TABLES: [&str; 11] = [
    "admin_user",
    "admin_session",
    "genre",
    "media_asset",
    "movie",
    "series",
    "season",
    "episode",
    "movie_genre",
    "series_genre",
    "file_cleanup_job",
];

async fn isolated_database() -> DatabaseTransaction {
    let url = std::env::var("TEST_DATABASE_URL").expect(
        "TEST_DATABASE_URL is required; start PostgreSQL with docker compose -f docker-compose.test.yml up -d postgres",
    );
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let schema = format!("migration_test_{}", Uuid::new_v4().simple());
    tx.execute_unprepared(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}"
    ))
    .await
    .unwrap();
    tx
}

async fn sql(db: &DatabaseTransaction, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

async fn rejects(db: &DatabaseTransaction, statement: &str, code: &str) {
    let savepoint = db.begin().await.unwrap();
    let error = savepoint.execute_unprepared(statement).await.unwrap_err();
    let sea_orm::DbErr::Exec(sea_orm::RuntimeErr::SqlxError(error)) = error else {
        panic!("expected PostgreSQL constraint violation: {error}");
    };
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some(code)
    );
    savepoint.rollback().await.unwrap();
}

#[tokio::test]
async fn core_schema_is_reversible() {
    let db = isolated_database().await;
    migration::Migrator::up(&db, None).await.unwrap();
    for table in TABLES {
        sql(&db, &format!("SELECT * FROM {table} LIMIT 0")).await;
    }
    migration::Migrator::down(&db, None).await.unwrap();
    for table in TABLES {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT to_regclass($1)::text AS relation",
                [table.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<Option<String>>("", "relation").unwrap(), None);
    }
    migration::Migrator::up(&db, None).await.unwrap();
    for table in TABLES {
        sql(&db, &format!("SELECT * FROM {table} LIMIT 0")).await;
    }
    db.rollback().await.unwrap();
}

#[tokio::test]
async fn episode_synopsis_migration_is_reversible() {
    let db = isolated_database().await;
    migration::Migrator::up(&db, Some(3)).await.unwrap();
    sql(
        &db,
        "INSERT INTO series (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Series')",
    )
    .await;
    sql(&db, "INSERT INTO season (id, series_id, number) VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1)").await;
    sql(&db, "INSERT INTO episode (id, season_id, number, name, synopsis) VALUES ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', 1, 'Pilot', 'remove me')").await;
    migration::Migrator::up(&db, None).await.unwrap();
    let row = db.query_one(Statement::from_string(DbBackend::Postgres,
        "SELECT count(*)::bigint AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='episode' AND column_name='synopsis'")).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    migration::Migrator::down(&db, Some(1)).await.unwrap();
    sql(&db, "INSERT INTO episode (id, season_id, number, name) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 2, 'Second')").await;
    db.rollback().await.unwrap();
}

#[tokio::test]
async fn core_schema_enforces_catalog_constraints() {
    let db = isolated_database().await;
    migration::Migrator::up(&db, None).await.unwrap();
    sql(&db, "INSERT INTO series (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Series'), ('00000000-0000-0000-0000-000000000002', 'Other series')").await;
    sql(&db, "INSERT INTO season (id, series_id, number) VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1), ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002', 1)").await;
    rejects(&db, "INSERT INTO season (id, series_id, number) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 1)", "23505").await;
    sql(&db, "INSERT INTO episode (id, season_id, number, name) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 1, 'Pilot'), (gen_random_uuid(), '00000000-0000-0000-0000-000000000012', 1, 'Another pilot')").await;
    rejects(&db, "INSERT INTO episode (id, season_id, number, name) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 1, 'Duplicate')", "23505").await;
    sql(
        &db,
        "INSERT INTO genre (id, name) VALUES (gen_random_uuid(), 'Drama')",
    )
    .await;
    rejects(
        &db,
        "INSERT INTO genre (id, name) VALUES (gen_random_uuid(), 'Drama')",
        "23505",
    )
    .await;
    for name in ["''", "'   '", "NULL"] {
        rejects(
            &db,
            &format!("INSERT INTO movie (id, name) VALUES (gen_random_uuid(), {name})"),
            if name == "NULL" { "23502" } else { "23514" },
        )
        .await;
    }
    for status in ["draft", "published", "archived"] {
        sql(&db, &format!("INSERT INTO movie (id, name, status) VALUES (gen_random_uuid(), 'Movie', '{status}')")).await;
        sql(&db, &format!("INSERT INTO series (id, name, status) VALUES (gen_random_uuid(), 'Series', '{status}')")).await;
        sql(&db, &format!("INSERT INTO episode (id, season_id, number, name, status) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', {}, 'Episode', '{status}')", match status { "draft" => 2, "published" => 3, _ => 4 })).await;
    }
    for table in ["movie", "series", "episode"] {
        rejects(
            &db,
            &format!("UPDATE {table} SET status = 'deleted'"),
            "23514",
        )
        .await;
        rejects(&db, &format!("UPDATE {table} SET version = 0"), "23514").await;
    }
    rejects(&db, "UPDATE episode SET name = ''", "23514").await;
    rejects(&db, "UPDATE season SET number = 0", "23514").await;
    rejects(&db, "UPDATE episode SET number = 0", "23514").await;
    db.rollback().await.unwrap();
}

#[tokio::test]
async fn foreign_keys_protect_references_and_keep_cleanup_retryable() {
    let db = isolated_database().await;
    migration::Migrator::up(&db, None).await.unwrap();
    sql(&db, "INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES ('00000000-0000-0000-0000-000000000021', 'video/21.mp4', 'video.mp4', 'video/mp4', 32, 'video')").await;
    sql(
        &db,
        "INSERT INTO series (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Series')",
    )
    .await;
    sql(&db, "INSERT INTO season (id, series_id, number) VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1)").await;
    sql(&db, "INSERT INTO episode (id, season_id, number, name, video_asset_id) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 1, 'Pilot', '00000000-0000-0000-0000-000000000021')").await;
    sql(
        &db,
        "INSERT INTO genre (id, name) VALUES ('00000000-0000-0000-0000-000000000031', 'Drama')",
    )
    .await;
    sql(&db, "INSERT INTO series_genre (series_id, genre_id) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000031')").await;
    rejects(
        &db,
        "INSERT INTO series_genre SELECT * FROM series_genre",
        "23505",
    )
    .await;
    rejects(&db, "DELETE FROM genre", "23503").await;
    rejects(&db, "DELETE FROM media_asset", "23503").await;
    rejects(&db, "INSERT INTO movie (id, name, video_asset_id) VALUES (gen_random_uuid(), 'Movie', gen_random_uuid())", "23503").await;
    sql(&db, "INSERT INTO file_cleanup_job (id, media_asset_id) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000021')").await;
    rejects(&db, "INSERT INTO file_cleanup_job (id, media_asset_id) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000021')", "23505").await;
    sql(&db, "DELETE FROM series").await;
    for table in ["season", "episode", "series_genre"] {
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                format!("SELECT count(*) AS count FROM {table}"),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    }
    // The queued job and its storage key survive deletion of the content tree.
    let row = db.query_one(Statement::from_string(DbBackend::Postgres, "SELECT storage_key FROM file_cleanup_job JOIN media_asset ON media_asset.id = file_cleanup_job.media_asset_id")).await.unwrap().unwrap();
    assert_eq!(
        row.try_get::<String>("", "storage_key").unwrap(),
        "video/21.mp4"
    );
    rejects(&db, "DELETE FROM media_asset", "23503").await;
    sql(
        &db,
        "DELETE FROM file_cleanup_job; DELETE FROM media_asset; DELETE FROM genre",
    )
    .await;
    db.rollback().await.unwrap();
}

#[tokio::test]
async fn entities_load_catalog_hierarchy_genres_media_and_sessions() {
    use movie_harbor_api::entities::{
        admin_session, admin_user, episode, file_cleanup_job, genre, media_asset, movie,
        movie_genre, season, series, series_genre,
    };
    use sea_orm::{
        ColumnTrait, EntityTrait, JoinType, ModelTrait, QueryFilter, QuerySelect, RelationTrait,
    };

    let db = isolated_database().await;
    migration::Migrator::up(&db, None).await.unwrap();
    sql(&db, "INSERT INTO admin_user (id, name, password_hash) VALUES ('00000000-0000-0000-0000-000000000041', 'Admin', 'password-hash')").await;
    sql(&db, "INSERT INTO admin_session (id, admin_user_id, token_hash, csrf_token_hash, expires_at) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000041', 'token-hash', 'csrf-hash', CURRENT_TIMESTAMP + INTERVAL '1 day')").await;
    sql(&db, "INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES ('00000000-0000-0000-0000-000000000021', 'video/21.mp4', 'video.mp4', 'video/mp4', 32, 'video'), ('00000000-0000-0000-0000-000000000022', 'poster/22.png', 'poster.png', 'image/png', 16, 'poster')").await;
    sql(&db, "INSERT INTO movie (id, name, poster_asset_id, video_asset_id) VALUES ('00000000-0000-0000-0000-000000000051', 'Movie', '00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000021')").await;
    sql(&db, "INSERT INTO series (id, name, poster_asset_id) VALUES ('00000000-0000-0000-0000-000000000001', 'Series', '00000000-0000-0000-0000-000000000022')").await;
    sql(&db, "INSERT INTO season (id, series_id, number) VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1)").await;
    sql(&db, "INSERT INTO episode (id, season_id, number, name, video_asset_id) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 1, 'Pilot', '00000000-0000-0000-0000-000000000021')").await;
    sql(
        &db,
        "INSERT INTO genre (id, name) VALUES ('00000000-0000-0000-0000-000000000031', 'Drama')",
    )
    .await;
    sql(&db, "INSERT INTO movie_genre (movie_id, genre_id) VALUES ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000031')").await;
    sql(&db, "INSERT INTO series_genre (series_id, genre_id) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000031')").await;
    sql(&db, "INSERT INTO file_cleanup_job (id, media_asset_id) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000021')").await;

    let movie = movie::Entity::find().one(&db).await.unwrap().unwrap();
    assert_eq!(movie.status, "draft");
    assert_eq!(movie.version, 1);
    assert!(movie.published_at.is_none() && movie.archived_at.is_none());
    assert_eq!(
        movie
            .find_related(genre::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .name,
        "Drama"
    );
    let genre = genre::Entity::find_by_id(
        "00000000-0000-0000-0000-000000000031"
            .parse::<Uuid>()
            .unwrap(),
    )
    .one(&db)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        genre
            .find_related(movie::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        movie.id
    );
    let series = genre
        .find_related(series::Entity)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        series
            .find_related(genre::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        genre.id
    );
    assert_eq!(
        movie_genre::Entity::find()
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .movie_id,
        movie.id
    );
    assert_eq!(
        series_genre::Entity::find()
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .series_id,
        series.id
    );
    let season = series
        .find_related(season::Entity)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(season.number, 1);
    assert_eq!(
        season
            .find_related(series::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        series.id
    );
    let episode = season
        .find_related(episode::Entity)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(episode.name, "Pilot");
    assert_eq!(
        episode
            .find_related(season::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        season.id
    );
    assert_eq!(
        episode
            .find_related(media_asset::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .storage_key,
        "video/21.mp4"
    );
    assert_eq!(
        series
            .find_related(media_asset::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .storage_key,
        "poster/22.png"
    );
    for (relation, purpose) in [
        (movie::Relation::PosterAsset, "poster"),
        (movie::Relation::VideoAsset, "video"),
    ] {
        let linked_movie = movie::Entity::find()
            .join(JoinType::InnerJoin, relation.def())
            .filter(media_asset::Column::Purpose.eq(purpose))
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(linked_movie.id, movie.id);
    }
    let admin = admin_user::Entity::find().one(&db).await.unwrap().unwrap();
    let session = admin
        .find_related(admin_session::Entity)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.token_hash, "token-hash");
    assert_eq!(
        session
            .find_related(admin_user::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        admin.id
    );
    let cleanup = file_cleanup_job::Entity::find()
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cleanup.attempts, 0);
    let media = cleanup
        .find_related(media_asset::Entity)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(media.storage_key, "video/21.mp4");
    assert_eq!(
        media
            .find_related(file_cleanup_job::Entity)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .id,
        cleanup.id
    );
    db.rollback().await.unwrap();
}
