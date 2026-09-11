use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    app,
    config::Config,
    entities::{file_cleanup_job, genre, media_asset, movie, movie_genre},
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, Set,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tower::ServiceExt;
use uuid::Uuid;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_movies_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}

impl AsRef<Path> for TempRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn database() -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("movies_test_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut options = ConnectOptions::new(url);
    options.set_schema_search_path(schema);
    let db = Database::connect(options).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
    db
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json");
    if let Some(value) = cookie {
        builder = builder.header("cookie", value);
    }
    if let Some(value) = csrf {
        builder = builder.header("x-csrf-token", value);
    }
    if let Some(value) = origin {
        builder = builder.header("origin", value);
    }
    let mut request = builder.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn credentials(app: &Router) -> (String, String) {
    let response = request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        None,
        None,
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let csrf = body(session).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    (cookie, csrf)
}

async fn write(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    cookie: &str,
    csrf: &str,
) -> Response {
    request(
        app,
        method,
        path,
        payload,
        Some(cookie),
        Some(csrf),
        Some("https://harbor.test"),
    )
    .await
}

async fn create_movie(app: &Router, cookie: &str, csrf: &str, name: &str) -> Value {
    let response = write(
        app,
        "POST",
        "/api/admin/movies",
        json!({"name":name}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    body(response).await
}

async fn create_asset(
    db: &DatabaseConnection,
    root: &Path,
    purpose: &str,
    mime_type: &str,
    make_regular_file: bool,
) -> media_asset::Model {
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let extension = match mime_type {
        "image/png" => "png",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };
    let key = format!("{purpose}/{}/{}.{}", &simple[..2], simple, extension);
    let path = root.join(&key);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if make_regular_file {
        std::fs::write(&path, b"registered media").unwrap();
    } else {
        std::fs::create_dir(&path).unwrap();
    }
    media_asset::ActiveModel {
        id: Set(id),
        storage_key: Set(key),
        original_name: Set(format!("asset.{extension}")),
        mime_type: Set(mime_type.into()),
        byte_size: Set(16),
        purpose: Set(purpose.into()),
        checksum_sha256: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn associate(
    app: &Router,
    cookie: &str,
    csrf: &str,
    movie_id: &str,
    kind: &str,
    asset_id: Uuid,
    version: i64,
) -> Response {
    write(
        app,
        "PUT",
        &format!("/api/admin/movies/{movie_id}/{kind}"),
        json!({"asset_id":asset_id.to_string(), "version":version}),
        cookie,
        csrf,
    )
    .await
}

// Catches missing route registration and bypasses of session, CSRF, or configured-origin checks.
#[tokio::test]
async fn movie_admin_routes_are_authenticated_and_create_list_detail_drafts() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();

    for (cookie, csrf, origin, expected) in [
        (
            None,
            None,
            Some("https://harbor.test"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            Some("bad=token"),
            Some("bad"),
            Some("https://harbor.test"),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/admin/movies",
                json!({"name":"Arrival"}),
                cookie,
                csrf,
                origin,
            )
            .await
            .status(),
            expected
        );
    }
    let (cookie, csrf) = credentials(&app).await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/movies",
            json!({"name":"Arrival"}),
            Some(&cookie),
            None,
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/movies",
            json!({"name":"Arrival"}),
            Some(&cookie),
            Some(&csrf),
            Some("https://evil.test"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let created = create_movie(&app, &cookie, &csrf, "  Arrival  ").await;
    assert_eq!(created["name"], "Arrival");
    assert_eq!(created["status"], "draft");
    assert_eq!(created["version"], 1);
    assert_eq!(created["genres"], json!([]));
    assert!(created.get("storage_key").is_none());
    let id = created["id"].as_str().unwrap();

    let detail = request(
        &app,
        "GET",
        &format!("/api/admin/movies/{id}"),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(detail.status(), StatusCode::OK);
    assert_eq!(body(detail).await, created);
    let listed = request(
        &app,
        "GET",
        "/api/admin/movies?status=draft&name=rriv",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(body(listed).await, json!([created]));
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/movies",
            json!(null),
            None,
            None,
            None,
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

// Catches partial metadata/genre commits, inactive association, or replacing omitted associations.
#[tokio::test]
async fn draft_updates_are_atomic_and_preserve_omitted_genres() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let genres = genre::Entity::find().all(&db).await.unwrap();
    let active_id = genres[0].id;
    let inactive_id = genres[1].id;
    let mut inactive: genre::ActiveModel = genres[1].clone().into();
    inactive.enabled = Set(false);
    inactive.update(&db).await.unwrap();
    let created = create_movie(&app, &cookie, &csrf, "Draft").await;
    let id = created["id"].as_str().unwrap();

    let updated = write(
        &app,
        "PATCH",
        &format!("/api/admin/movies/{id}"),
        json!({
            "version":1,
            "name":"Updated",
            "synopsis":"A story",
            "year":2016,
            "duration_seconds":6960,
            "genre_ids":[active_id.to_string()]
        }),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = body(updated).await;
    assert_eq!(updated["version"], 2);
    assert_eq!(updated["genres"][0]["id"], active_id.to_string());

    let rejected = write(
        &app,
        "PATCH",
        &format!("/api/admin/movies/{id}"),
        json!({"version":2,"name":"Must roll back","genre_ids":[inactive_id.to_string()]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let current = movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.name, "Updated");
    assert_eq!(current.version, 2);

    let preserved = write(
        &app,
        "PATCH",
        &format!("/api/admin/movies/{id}"),
        json!({"version":2,"synopsis":"Changed only"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(preserved.status(), StatusCode::OK);
    let preserved = body(preserved).await;
    assert_eq!(preserved["genres"][0]["id"], active_id.to_string());
    assert_eq!(
        movie_genre::Entity::find()
            .filter(movie_genre::Column::MovieId.eq(id.parse::<Uuid>().unwrap()))
            .count(&db)
            .await
            .unwrap(),
        1
    );

    let replacement_genre_id = genres[2].id;
    let mut previously_active: genre::ActiveModel = genre::Entity::find_by_id(active_id)
        .one(&db)
        .await
        .unwrap()
        .unwrap()
        .into();
    previously_active.enabled = Set(false);
    previously_active.update(&db).await.unwrap();
    let changed_selection = write(
        &app,
        "PATCH",
        &format!("/api/admin/movies/{id}"),
        json!({"version":3,"genre_ids":[replacement_genre_id.to_string()]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(changed_selection.status(), StatusCode::OK);
    let changed_selection = body(changed_selection).await;
    let ids = changed_selection["genres"]
        .as_array()
        .unwrap()
        .iter()
        .map(|genre| genre["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(ids.contains(&active_id.to_string()));
    assert!(ids.contains(&replacement_genre_id.to_string()));

    let duplicate_existing = write(
        &app,
        "PATCH",
        &format!("/api/admin/movies/{id}"),
        json!({"version":4,"genre_ids":[active_id.to_string(), active_id.to_string()]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(duplicate_existing.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        4
    );
}

// Catches media ID/type confusion, stale association writes, storage-key leaks, and eager old-file deletion.
#[tokio::test]
async fn media_association_is_versioned_and_schedules_replaced_assets() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Media movie").await;
    let id = created["id"].as_str().unwrap();
    let first = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let second = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;

    let response = associate(&app, &cookie, &csrf, id, "poster", first.id, 1).await;
    assert_eq!(response.status(), StatusCode::OK);
    let associated = body(response).await;
    assert_eq!(associated["version"], 2);
    assert_eq!(associated["poster"]["id"], first.id.to_string());
    assert_eq!(
        associated["poster"]["url"],
        format!("/media/{}", first.storage_key)
    );
    assert!(associated["poster"].get("storage_key").is_none());
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "video", video.id, 1)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "poster", video.id, 2)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "poster", Uuid::new_v4(), 2,)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let replaced = associate(&app, &cookie, &csrf, id, "poster", second.id, 2).await;
    assert_eq!(replaced.status(), StatusCode::OK);
    assert_eq!(body(replaced).await["version"], 3);
    assert!(root.as_ref().join(&first.storage_key).is_file());
    let jobs = file_cleanup_job::Entity::find().all(&db).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].media_asset_id, first.id);
}

// Catches publishing without both registered files or trusting unsafe/missing/non-regular keys.
#[tokio::test]
async fn publish_requires_valid_accessible_poster_and_browser_video() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Publishable").await;
    let id = created["id"].as_str().unwrap();

    let missing = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let missing = body(missing).await;
    assert_eq!(missing["fields"], json!(["poster", "video"]));

    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let inaccessible_video = create_asset(&db, root.as_ref(), "video", "video/mp4", false).await;
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "poster", poster.id, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "video", inaccessible_video.id, 2,)
            .await
            .status(),
        StatusCode::OK
    );
    let invalid = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body(invalid).await["fields"], json!(["video"]));
    assert_eq!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .status,
        "draft"
    );

    let invalid_key_movie = create_movie(&app, &cookie, &csrf, "Unsafe key").await;
    let invalid_key_id = invalid_key_movie["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let unsafe_video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    let mut unsafe_active: media_asset::ActiveModel = unsafe_video.clone().into();
    unsafe_active.storage_key = Set("../outside.mp4".into());
    unsafe_active.update(&db).await.unwrap();
    assert_eq!(
        associate(&app, &cookie, &csrf, invalid_key_id, "poster", poster.id, 1,)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(
            &app,
            &cookie,
            &csrf,
            invalid_key_id,
            "video",
            unsafe_video.id,
            2,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        write(
            &app,
            "POST",
            &format!("/api/admin/movies/{invalid_key_id}/publish"),
            json!({"version":3}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let missing_file_movie = create_movie(&app, &cookie, &csrf, "Missing file").await;
    let missing_file_id = missing_file_movie["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let absent_video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    std::fs::remove_file(root.as_ref().join(&absent_video.storage_key)).unwrap();
    assert_eq!(
        associate(
            &app,
            &cookie,
            &csrf,
            missing_file_id,
            "poster",
            poster.id,
            1,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(
            &app,
            &cookie,
            &csrf,
            missing_file_id,
            "video",
            absent_video.id,
            2,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        write(
            &app,
            "POST",
            &format!("/api/admin/movies/{missing_file_id}/publish"),
            json!({"version":3}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let wrong_mime_movie = create_movie(&app, &cookie, &csrf, "Wrong MIME").await;
    let wrong_mime_id = wrong_mime_movie["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let wrong_mime_video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    let mut wrong_mime_active: media_asset::ActiveModel = wrong_mime_video.clone().into();
    wrong_mime_active.mime_type = Set("video/quicktime".into());
    wrong_mime_active.update(&db).await.unwrap();
    assert_eq!(
        associate(&app, &cookie, &csrf, wrong_mime_id, "poster", poster.id, 1,)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(
            &app,
            &cookie,
            &csrf,
            wrong_mime_id,
            "video",
            wrong_mime_video.id,
            2,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        write(
            &app,
            "POST",
            &format!("/api/admin/movies/{wrong_mime_id}/publish"),
            json!({"version":3}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

// Catches a blocking FIFO open pinning an async worker and holding the movie row lock.
#[cfg(unix)]
#[tokio::test]
async fn publish_rejects_a_fifo_without_waiting_for_a_writer() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "FIFO movie").await;
    let id = created["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "poster", poster.id, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "video", video.id, 2)
            .await
            .status(),
        StatusCode::OK
    );

    let fifo = root.as_ref().join(&video.storage_key);
    std::fs::remove_file(&fifo).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let delayed_writer_path = fifo.clone();
    let delayed_writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(delayed_writer_path)
            .unwrap()
    });

    let started = Instant::now();
    let response = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    let elapsed = started.elapsed();
    delayed_writer.join().unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        elapsed < Duration::from_millis(300),
        "publish blocked on FIFO open for {elapsed:?}"
    );
}

// Catches incorrect transitions, mutable non-drafts, non-idempotent retries, and published deletion.
#[tokio::test]
async fn lifecycle_state_machine_enforces_read_only_idempotency_and_delete_rules() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Lifecycle").await;
    let id = created["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "poster", poster.id, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&app, &cookie, &csrf, id, "video", video.id, 2)
            .await
            .status(),
        StatusCode::OK
    );

    let published = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(published.status(), StatusCode::OK);
    let published = body(published).await;
    assert_eq!(published["status"], "published");
    assert_eq!(published["version"], 4);
    let published_at = published["published_at"].clone();

    let repeated = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(repeated.status(), StatusCode::OK);
    let repeated = body(repeated).await;
    assert_eq!(repeated["version"], 4);
    assert_eq!(repeated["published_at"], published_at);
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!("/api/admin/movies/{id}"),
            json!({"version":4,"name":"Forbidden"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/movies/{id}"),
            json!({"version":4}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let archived = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/archive"),
        json!({"version":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    let archived = body(archived).await;
    assert_eq!(archived["status"], "archived");
    assert_eq!(archived["version"], 5);
    assert!(archived["archived_at"].is_string());
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!("/api/admin/movies/{id}"),
            json!({"version":5,"name":"Still forbidden"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let republished = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/publish"),
        json!({"version":5}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(republished.status(), StatusCode::OK);
    let republished = body(republished).await;
    assert_eq!(republished["status"], "published");
    assert_eq!(republished["version"], 6);
    assert_eq!(republished["published_at"], published_at);

    assert_eq!(
        write(
            &app,
            "POST",
            &format!("/api/admin/movies/{id}/archive"),
            json!({"version":6}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
    let draft = write(
        &app,
        "POST",
        &format!("/api/admin/movies/{id}/draft"),
        json!({"version":7}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(draft.status(), StatusCode::OK);
    let draft = body(draft).await;
    assert_eq!(draft["status"], "draft");
    assert_eq!(draft["version"], 8);
    assert!(draft["published_at"].is_null());
    assert!(draft["archived_at"].is_null());
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/movies/{id}"),
            json!({"version":8}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        file_cleanup_job::Entity::find().count(&db).await.unwrap(),
        2
    );

    let archived_delete = create_movie(&app, &cookie, &csrf, "Archived delete").await;
    let archived_id = archived_delete["id"].as_str().unwrap();
    db.execute_unprepared(&format!(
        "UPDATE movie SET status = 'archived' WHERE id = '{archived_id}'"
    ))
    .await
    .unwrap();
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/movies/{archived_id}"),
            json!({"version":1}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
}

// Catches a missing version predicate or a check-then-write race that accepts both writers.
#[tokio::test]
async fn stale_and_concurrent_writes_have_one_winner_and_deterministic_conflicts() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Concurrent").await;
    let id = created["id"].as_str().unwrap().to_owned();

    let path = format!("/api/admin/movies/{id}");
    let first = write(
        &app,
        "PATCH",
        &path,
        json!({"version":1,"synopsis":"first"}),
        &cookie,
        &csrf,
    );
    let second = write(
        &app,
        "PATCH",
        &path,
        json!({"version":1,"synopsis":"second"}),
        &cookie,
        &csrf,
    );
    let (first, second) = tokio::join!(first, second);
    let mut statuses = [first.status(), second.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let current = movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.version, 2);
    assert!(matches!(current.synopsis.as_str(), "first" | "second"));

    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/movies/{id}"),
            json!({"version":1}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
}

// Catches movie deletion committing before all unique cleanup jobs can be enqueued.
#[tokio::test]
async fn delete_rolls_back_movie_and_cleanup_jobs_on_failure() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Rollback").await;
    let id = created["id"].as_str().unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    let poster_response = associate(&app, &cookie, &csrf, id, "poster", poster.id, 1).await;
    assert_eq!(poster_response.status(), StatusCode::OK);
    let video_response = associate(&app, &cookie, &csrf, id, "video", video.id, 2).await;
    assert_eq!(video_response.status(), StatusCode::OK);
    db.execute_unprepared(&format!(
        "CREATE FUNCTION reject_video_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.media_asset_id = '{video_id}'::uuid THEN \
         RAISE EXCEPTION 'forced cleanup failure'; END IF; RETURN NEW; END $$; \
         CREATE TRIGGER reject_video_cleanup BEFORE INSERT ON file_cleanup_job \
         FOR EACH ROW EXECUTE FUNCTION reject_video_cleanup()",
        video_id = video.id,
    ))
    .await
    .unwrap();

    let response = write(
        &app,
        "DELETE",
        &format!("/api/admin/movies/{id}"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        file_cleanup_job::Entity::find().count(&db).await.unwrap(),
        0
    );
}

// Catches malformed identifiers being confused with absent resources.
#[tokio::test]
async fn invalid_and_missing_movie_identifiers_are_mapped_consistently() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db, &config(root.as_ref())).await.unwrap();
    let (cookie, _) = credentials(&app).await;
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/movies/not-a-uuid",
            json!(null),
            Some(&cookie),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/admin/movies/{}", Uuid::new_v4()),
            json!(null),
            Some(&cookie),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}
