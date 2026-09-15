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
    entities::{episode, genre, media_asset, season, series, series_genre},
    media::{LocalMediaStorage, StorageEvent, StorageHooks},
    series::service as series_service,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, Set,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_series_{}", Uuid::new_v4()));
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
    std::fs::write(
        root.join(".movie-harbor-volume.json"),
        r#"{"version":1,"volume":0}"#,
    )
    .unwrap();
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dirs: vec![root.into()],
        media_disk_reserve_bytes: 1,
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn database() -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("series_test_{}", Uuid::new_v4().simple());
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

async fn create_series(app: &Router, cookie: &str, csrf: &str, name: &str) -> Value {
    let response = write(
        app,
        "POST",
        "/api/admin/series",
        json!({"name":name}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    body(response).await
}

async fn add_season(
    app: &Router,
    cookie: &str,
    csrf: &str,
    series_id: &str,
    version: i64,
    number: i32,
) -> Response {
    write(
        app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons"),
        json!({"version":version,"number":number}),
        cookie,
        csrf,
    )
    .await
}

async fn add_episode(
    app: &Router,
    cookie: &str,
    csrf: &str,
    hierarchy: (&str, &str),
    series_version: i64,
    number: i32,
    name: &str,
) -> Response {
    let (series_id, season_id) = hierarchy;
    write(
        app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes"),
        json!({"version":series_version,"number":number,"name":name}),
        cookie,
        csrf,
    )
    .await
}

async fn create_asset(
    db: &DatabaseConnection,
    root: &Path,
    purpose: &str,
    mime_type: &str,
) -> media_asset::Model {
    const CONTENT: &[u8] = b"registered media";
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
    std::fs::write(path, CONTENT).unwrap();
    media_asset::ActiveModel {
        id: Set(id),
        storage_key: Set(key),
        original_name: Set(format!("asset.{extension}")),
        mime_type: Set(mime_type.into()),
        byte_size: Set(16),
        purpose: Set(purpose.into()),
        checksum_sha256: Set(Some(format!("{:x}", Sha256::digest(CONTENT)))),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn attach_series_poster(db: &DatabaseConnection, id: Uuid, asset_id: Uuid) {
    let mut active: series::ActiveModel = series::Entity::find_by_id(id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into();
    active.poster_asset_id = Set(Some(asset_id));
    active.update(db).await.unwrap();
}

async fn attach_episode_video(db: &DatabaseConnection, id: Uuid, asset_id: Uuid) {
    let mut active: episode::ActiveModel = episode::Entity::find_by_id(id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into();
    active.video_asset_id = Set(Some(asset_id));
    active.update(db).await.unwrap();
}

struct FailSecondStage {
    stages: AtomicUsize,
}

impl StorageHooks for FailSecondStage {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::BeforeStage(_))
            && self.stages.fetch_add(1, Ordering::SeqCst) == 1
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected stage permission failure",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
struct MakeOperationReadOnlyAfterStage {
    root: PathBuf,
}

#[cfg(unix)]
impl StorageHooks for MakeOperationReadOnlyAfterStage {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::AfterStageRename(_)) {
            let operation = std::fs::read_dir(self.root.join(".operations"))?
                .next()
                .expect("the removal operation exists")?
                .path();
            std::fs::set_permissions(operation, std::fs::Permissions::from_mode(0o500))?;
        }
        Ok(())
    }
}

async fn hierarchy_ids(value: &Value) -> (String, String) {
    (
        value["seasons"][0]["id"].as_str().unwrap().to_owned(),
        value["seasons"][0]["episodes"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}

// Catches missing route registration, auth/CSRF/origin bypass, DTO leakage, and missing versions.
#[tokio::test]
async fn admin_routes_create_list_and_return_versioned_hierarchy_without_storage_keys() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();

    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/series",
            json!({"name":"The Expanse"}),
            None,
            None,
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = credentials(&app).await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/series",
            json!({"name":"The Expanse"}),
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
            "/api/admin/series",
            json!({"name":"The Expanse"}),
            Some(&cookie),
            Some(&csrf),
            Some("https://evil.test"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let created = create_series(&app, &cookie, &csrf, "  The Expanse  ").await;
    assert_eq!(created["name"], "The Expanse");
    assert_eq!(created["status"], "draft");
    assert_eq!(created["version"], 1);
    assert_eq!(created["genres"], json!([]));
    assert_eq!(created["seasons"], json!([]));
    assert!(created.get("storage_key").is_none());
    let id = created["id"].as_str().unwrap();

    let season_response = add_season(&app, &cookie, &csrf, id, 1, 1).await;
    assert_eq!(season_response.status(), StatusCode::CREATED);
    let with_season = body(season_response).await;
    assert_eq!(with_season["version"], 2);
    assert_eq!(with_season["seasons"][0]["number"], 1);
    let season_object = with_season["seasons"][0].as_object().unwrap();
    assert_eq!(season_object.len(), 3);
    assert!(season_object.contains_key("id"));
    assert!(season_object.contains_key("number"));
    assert!(season_object.contains_key("episodes"));
    let season_id = with_season["seasons"][0]["id"].as_str().unwrap();

    let episode_response =
        add_episode(&app, &cookie, &csrf, (id, season_id), 2, 1, "  Dulcinea  ").await;
    assert_eq!(episode_response.status(), StatusCode::CREATED);
    let hierarchy = body(episode_response).await;
    assert_eq!(hierarchy["version"], 3);
    let episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap();
    let updated = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{id}/seasons/{season_id}/episodes/{episode_id}"),
        json!({"version": 1, "number": 1, "name": "Dulcinea", "duration_seconds": 2700}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    let hierarchy = body(
        request(
            &app,
            "GET",
            &format!("/api/admin/series/{id}"),
            json!(null),
            Some(&cookie),
            None,
            None,
        )
        .await,
    )
    .await;
    let episode = &hierarchy["seasons"][0]["episodes"][0];
    assert!(episode.get("synopsis").is_none());
    assert_eq!(episode["name"], "Dulcinea");
    assert_eq!(episode["duration_seconds"], 2700);
    assert_eq!(episode["version"], 2);
    assert!(
        hierarchy["seasons"][0]["episodes"][0]
            .get("storage_key")
            .is_none()
    );

    let detail = request(
        &app,
        "GET",
        &format!("/api/admin/series/{id}"),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(detail.status(), StatusCode::OK);
    assert_eq!(body(detail).await, hierarchy);
    let listed = request(
        &app,
        "GET",
        "/api/admin/series?status=draft&name=xpan",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(body(listed).await, json!([hierarchy]));
}

// Catches partial metadata/genre commits and accidental removal/addition of inactive genres.
#[tokio::test]
async fn draft_series_updates_are_atomic_and_preserve_inactive_existing_genres() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let genres = genre::Entity::find().all(&db).await.unwrap();
    let existing_id = genres[0].id;
    let inactive_new_id = genres[1].id;
    let replacement_id = genres[2].id;
    let created = create_series(&app, &cookie, &csrf, "Draft").await;
    let id = created["id"].as_str().unwrap();

    let updated = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{id}"),
        json!({
            "version":1,
            "name":"Updated",
            "synopsis":"Belter politics",
            "year":2015,
            "genre_ids":[existing_id.to_string()]
        }),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(body(updated).await["version"], 2);

    for genre_id in [existing_id, inactive_new_id] {
        let mut active: genre::ActiveModel = genre::Entity::find_by_id(genre_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .into();
        active.enabled = Set(false);
        active.update(&db).await.unwrap();
    }
    let rejected = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{id}"),
        json!({"version":2,"name":"Must roll back","genre_ids":[inactive_new_id.to_string()]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let current = series::Entity::find_by_id(id.parse::<Uuid>().unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.name, "Updated");
    assert_eq!(current.version, 2);

    let changed = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{id}"),
        json!({"version":2,"genre_ids":[replacement_id.to_string()]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(changed.status(), StatusCode::OK);
    let changed = body(changed).await;
    let ids = changed["genres"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.contains(&existing_id.to_string().as_str()));
    assert!(ids.contains(&replacement_id.to_string().as_str()));
    assert_eq!(
        series_genre::Entity::find()
            .filter(series_genre::Column::SeriesId.eq(id.parse::<Uuid>().unwrap()))
            .count(&db)
            .await
            .unwrap(),
        2
    );
}

// Catches unscoped IDs, absent optimistic predicates, and non-deterministic unique violations.
#[tokio::test]
async fn hierarchy_commands_scope_ids_and_serialize_duplicate_numbers() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let first = create_series(&app, &cookie, &csrf, "First").await;
    let second = create_series(&app, &cookie, &csrf, "Second").await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();

    let season = add_season(&app, &cookie, &csrf, first_id, 1, 1).await;
    assert_eq!(season.status(), StatusCode::CREATED);
    let first_hierarchy = body(season).await;
    let first_season_id = first_hierarchy["seasons"][0]["id"].as_str().unwrap();
    assert_eq!(
        add_season(&app, &cookie, &csrf, first_id, 1, 2)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        add_season(&app, &cookie, &csrf, first_id, 2, 1)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        add_season(&app, &cookie, &csrf, second_id, 1, 1)
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (second_id, first_season_id),
            2,
            1,
            "Wrong parent"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (first_id, first_season_id),
            2,
            1,
            "   "
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let episode = add_episode(
        &app,
        &cookie,
        &csrf,
        (first_id, first_season_id),
        2,
        1,
        "Pilot",
    )
    .await;
    assert_eq!(episode.status(), StatusCode::CREATED);
    assert_eq!(body(episode).await["version"], 3);
    assert_eq!(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (first_id, first_season_id),
            3,
            1,
            "Duplicate"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        series::Entity::find_by_id(first_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        3
    );

    let concurrent = create_series(&app, &cookie, &csrf, "Concurrent seasons").await;
    let concurrent_id = concurrent["id"].as_str().unwrap().to_owned();
    let one = add_season(&app, &cookie, &csrf, &concurrent_id, 1, 1);
    let two = add_season(&app, &cookie, &csrf, &concurrent_id, 1, 1);
    let (one, two) = tokio::join!(one, two);
    let mut statuses = [one.status(), two.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    assert_eq!(
        season::Entity::find()
            .filter(season::Column::SeriesId.eq(concurrent_id.parse::<Uuid>().unwrap()))
            .count(&db)
            .await
            .unwrap(),
        1
    );
}

// Catches treating a published series as fully frozen or failing to protect published seasons.
#[tokio::test]
async fn published_series_is_read_only_but_accepts_new_draft_children() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Ongoing").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &season_id),
            2,
            1,
            "Pilot",
        )
        .await,
    )
    .await;
    let episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, series_id.parse().unwrap(), poster.id).await;
    attach_episode_video(&db, episode_id.parse().unwrap(), video.id).await;

    let episode_published = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(episode_published.status(), StatusCode::OK);
    let episode_published = body(episode_published).await;
    assert_eq!(episode_published["series_version"], 4);
    assert_eq!(episode_published["episode"]["version"], 2);

    let published = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/publish"),
        json!({"version":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(published.status(), StatusCode::OK);
    assert_eq!(body(published).await["version"], 5);
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!("/api/admin/series/{series_id}"),
            json!({"version":5,"name":"Forbidden"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let added = add_season(&app, &cookie, &csrf, &series_id, 5, 2).await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let added = body(added).await;
    let second_season_id = added["seasons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|season| season["number"] == 2)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let added_episode = add_episode(
        &app,
        &cookie,
        &csrf,
        (&series_id, &second_season_id),
        6,
        1,
        "New draft",
    )
    .await;
    assert_eq!(added_episode.status(), StatusCode::CREATED);
    assert_eq!(body(added_episode).await["version"], 7);

    for (method, path, payload) in [
        (
            "PATCH",
            format!("/api/admin/series/{series_id}/seasons/{season_id}"),
            json!({"version":7,"number":3}),
        ),
        (
            "DELETE",
            format!("/api/admin/series/{series_id}/seasons/{season_id}"),
            json!({"version":7}),
        ),
    ] {
        assert_eq!(
            write(&app, method, &path, payload, &cookie, &csrf)
                .await
                .status(),
            StatusCode::CONFLICT
        );
    }
    let renumbered = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{series_id}/seasons/{second_season_id}"),
        json!({"version":7,"number":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(renumbered.status(), StatusCode::OK);
    assert_eq!(body(renumbered).await["version"], 8);
    let deleted_draft_season = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{series_id}/seasons/{second_season_id}"),
        json!({"version":8}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted_draft_season.status(), StatusCode::OK);
    let deleted_draft_season = body(deleted_draft_season).await;
    assert_eq!(deleted_draft_season, json!({"deleted_media_count":0}));
    let current = request(
        &app,
        "GET",
        &format!("/api/admin/series/{series_id}"),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let current = body(current).await;
    assert_eq!(current["version"], 9);
    assert_eq!(current["seasons"].as_array().unwrap().len(), 1);
}

// Catches missing publish requirements, invalid transitions, and non-idempotent retries.
#[tokio::test]
async fn combined_lifecycle_validates_media_and_preserves_child_state_when_parent_is_archived() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Lifecycle").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &season_id),
            2,
            1,
            "Pilot",
        )
        .await,
    )
    .await;
    let episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let no_published_episode = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/publish"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(
        no_published_episode.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        body(no_published_episode).await["fields"],
        json!(["episodes"])
    );

    let missing_episode_media = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(
        missing_episode_media.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        body(missing_episode_media).await["fields"],
        json!(["video"])
    );
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, episode_id.parse().unwrap(), video.id).await;
    let episode_published = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(episode_published.status(), StatusCode::OK);
    let episode_published = body(episode_published).await;
    assert_eq!(episode_published["episode"]["status"], "published");
    assert_eq!(episode_published["series_version"], 4);
    let repeated_episode = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(repeated_episode.status(), StatusCode::OK);
    assert_eq!(body(repeated_episode).await["series_version"], 4);

    let published_without_poster = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/publish"),
        json!({"version":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(published_without_poster.status(), StatusCode::OK);
    let archived = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/archive"),
        json!({"version":5}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    let archived = body(archived).await;
    assert_eq!(archived["status"], "archived");
    assert_eq!(archived["version"], 6);
    assert_eq!(archived["seasons"][0]["episodes"][0]["status"], "published");
    let repeated_archive = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/archive"),
        json!({"version":5}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(repeated_archive.status(), StatusCode::OK);
    assert_eq!(body(repeated_archive).await["version"], 6);

    let effective_count = db
        .query_one(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            format!(
                "SELECT count(*)::bigint AS count FROM episode e JOIN season s ON s.id=e.season_id JOIN series r ON r.id=s.series_id WHERE r.id='{series_id}' AND r.status='published' AND e.status='published'"
            ),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "count")
        .unwrap();
    assert_eq!(effective_count, 0);

    let added = add_season(&app, &cookie, &csrf, &series_id, 6, 2).await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_eq!(body(added).await["version"], 7);
    let republished = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/publish"),
        json!({"version":7}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(republished.status(), StatusCode::OK);
    let republished = body(republished).await;
    assert_eq!(republished["version"], 8);
    assert_eq!(
        republished["seasons"][0]["episodes"][0]["status"],
        "published"
    );
}

// Catches episode lost updates, cross-season confusion, and duplicate-number races.
#[tokio::test]
async fn episode_writes_use_episode_versions_and_bump_the_parent_version_once() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Concurrent episodes").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (&series_id, &season_id), 2, 1, "One").await).await;
    let first_episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (&series_id, &season_id), 3, 2, "Two").await).await;
    let second_episode_id = hierarchy["seasons"][0]["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|episode| episode["number"] == 2)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let first_path =
        format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{first_episode_id}");
    let first = write(
        &app,
        "PATCH",
        &first_path,
        json!({"version":1,"name":"first"}),
        &cookie,
        &csrf,
    );
    let second = write(
        &app,
        "PATCH",
        &first_path,
        json!({"version":1,"name":"second"}),
        &cookie,
        &csrf,
    );
    let (first, second) = tokio::join!(first, second);
    let mut statuses = [first.status(), second.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    assert_eq!(
        episode::Entity::find_by_id(first_episode_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );
    assert_eq!(
        series::Entity::find_by_id(series_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        5
    );

    let one = write(
        &app,
        "PATCH",
        &first_path,
        json!({"version":2,"number":3}),
        &cookie,
        &csrf,
    );
    let two_path =
        format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{second_episode_id}");
    let two = write(
        &app,
        "PATCH",
        &two_path,
        json!({"version":1,"number":3}),
        &cookie,
        &csrf,
    );
    let (one, two) = tokio::join!(one, two);
    let mut statuses = [one.status(), two.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    assert_eq!(
        series::Entity::find_by_id(series_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        6
    );

    let other = create_series(&app, &cookie, &csrf, "Other").await;
    let other_id = other["id"].as_str().unwrap();
    let other_hierarchy = body(add_season(&app, &cookie, &csrf, other_id, 1, 1).await).await;
    let other_season_id = other_hierarchy["seasons"][0]["id"].as_str().unwrap();
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!(
                "/api/admin/series/{other_id}/seasons/{other_season_id}/episodes/{first_episode_id}"
            ),
            json!({"version":2,"name":"Wrong hierarchy"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

// Catches non-atomic cascades and media metadata surviving a successful content-tree delete.
#[tokio::test]
async fn parent_and_episode_deletion_are_atomic_with_media_deletion() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Delete tree").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (&series_id, &season_id), 2, 1, "One").await).await;
    let (_, first_episode_id) = hierarchy_ids(&hierarchy).await;
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (&series_id, &season_id), 3, 2, "Two").await).await;
    let second_episode_id = hierarchy["seasons"][0]["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["number"] == 2)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let exclusive_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, series_id.parse().unwrap(), poster.id).await;
    attach_episode_video(&db, first_episode_id.parse().unwrap(), exclusive_video.id).await;
    attach_episode_video(&db, second_episode_id.parse().unwrap(), second_video.id).await;

    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{series_id}"),
        json!({"version":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body(deleted).await, json!({"deleted_media_count":3}));
    assert!(
        series::Entity::find_by_id(series_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        season::Entity::find()
            .filter(season::Column::SeriesId.eq(series_id.parse::<Uuid>().unwrap()))
            .count(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(episode::Entity::find().count(&db).await.unwrap(), 0);
    for asset in [&poster, &exclusive_video, &second_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.as_ref().join(&asset.storage_key).exists());
    }

    let rollback = create_series(&app, &cookie, &csrf, "Rollback tree").await;
    let rollback_id = rollback["id"].as_str().unwrap().to_owned();
    let rollback_hierarchy = body(add_season(&app, &cookie, &csrf, &rollback_id, 1, 1).await).await;
    let rollback_season_id = rollback_hierarchy["seasons"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let rollback_hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&rollback_id, &rollback_season_id),
            2,
            1,
            "Rollback episode",
        )
        .await,
    )
    .await;
    let rollback_episode_id = rollback_hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let rollback_poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let rollback_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, rollback_id.parse().unwrap(), rollback_poster.id).await;
    attach_episode_video(&db, rollback_episode_id.parse().unwrap(), rollback_video.id).await;
    db.execute_unprepared(
        "CREATE FUNCTION reject_series_media_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced media delete failure'; END $$; CREATE TRIGGER reject_series_media_delete BEFORE DELETE ON media_asset FOR EACH ROW EXECUTE FUNCTION reject_series_media_delete()",
    )
    .await
    .unwrap();
    let rejected = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{rollback_id}"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(rejected.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(rejected).await["code"], "media_delete_failed");
    assert!(
        series::Entity::find_by_id(rollback_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        episode::Entity::find_by_id(rollback_episode_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    for asset in [&rollback_poster, &rollback_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_some()
        );
        assert!(root.as_ref().join(&asset.storage_key).is_file());
    }
}

// Catches concurrent independent tree deletes violating the global storage serialization order.
#[tokio::test]
async fn concurrent_series_deletes_remove_each_owned_asset_without_deadlock() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let first_asset = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let second_asset = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let first = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("First shared owner".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(Some(first_asset.id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let second = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Second shared owner".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(Some(second_asset.id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let first_db = db.clone();
    let second_db = db.clone();
    let first_storage = storage.clone();
    let second_storage = storage;
    let first_delete = tokio::spawn(async move {
        series_service::delete_series(&first_db, &first_storage.clone().into(), first.id, 1).await
    });
    let second_delete = tokio::spawn(async move {
        series_service::delete_series(&second_db, &second_storage.clone().into(), second.id, 1)
            .await
    });
    let (first_result, second_result) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(first_delete, second_delete)
    })
    .await
    .unwrap();
    assert_eq!(first_result.unwrap().unwrap().deleted_media_count, 1);
    assert_eq!(second_result.unwrap().unwrap().deleted_media_count, 1);

    assert_eq!(series::Entity::find().count(&db).await.unwrap(), 0);
    for asset in [&first_asset, &second_asset] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.as_ref().join(&asset.storage_key).exists());
    }
}

// Catches freezing descendant lifecycles merely because their containing series is archived.
#[tokio::test]
async fn archived_series_preserves_independent_child_lifecycles() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Archived parent").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &season_id),
            2,
            1,
            "First published",
        )
        .await,
    )
    .await;
    let first_episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &season_id),
            3,
            2,
            "Remaining published",
        )
        .await,
    )
    .await;
    let second_episode_id = hierarchy["seasons"][0]["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|episode| episode["number"] == 2)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let first_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, series_id.parse().unwrap(), poster.id).await;
    attach_episode_video(&db, first_episode_id.parse().unwrap(), first_video.id).await;
    attach_episode_video(&db, second_episode_id.parse().unwrap(), second_video.id).await;

    for episode_id in [&first_episode_id, &second_episode_id] {
        assert_eq!(
            write(
                &app,
                "POST",
                &format!(
                    "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"
                ),
                json!({"version":1}),
                &cookie,
                &csrf,
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        write(
            &app,
            "POST",
            &format!("/api/admin/series/{series_id}/publish"),
            json!({"version":6}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
    let archived = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/archive"),
        json!({"version":7}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    assert_eq!(body(archived).await["version"], 8);
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!("/api/admin/series/{series_id}"),
            json!({"version":8,"name":"Still read only"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 8, 2).await).await;
    assert_eq!(hierarchy["version"], 9);
    let draft_season_id = hierarchy["seasons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|season| season["number"] == 2)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &draft_season_id),
            9,
            1,
            "Archived-parent draft",
        )
        .await,
    )
    .await;
    assert_eq!(hierarchy["version"], 10);
    let draft_episode_id = hierarchy["seasons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|season| season["id"] == draft_season_id)
        .unwrap()["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let draft_episode_path = format!(
        "/api/admin/series/{series_id}/seasons/{draft_season_id}/episodes/{draft_episode_id}"
    );
    let edited = write(
        &app,
        "PATCH",
        &draft_episode_path,
        json!({"version":1,"name":"Editable under archive"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(edited.status(), StatusCode::OK);
    assert_eq!(body(edited).await["series_version"], 11);
    assert_eq!(
        write(
            &app,
            "DELETE",
            &draft_episode_path,
            json!({"version":2}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
    let renumbered = write(
        &app,
        "PATCH",
        &format!("/api/admin/series/{series_id}/seasons/{draft_season_id}"),
        json!({"version":12,"number":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(renumbered.status(), StatusCode::OK);
    assert_eq!(body(renumbered).await["version"], 13);
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/series/{series_id}/seasons/{draft_season_id}"),
            json!({"version":13}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );

    for (method, payload) in [
        ("PATCH", json!({"version":14,"number":4})),
        ("DELETE", json!({"version":14})),
    ] {
        assert_eq!(
            write(
                &app,
                method,
                &format!("/api/admin/series/{series_id}/seasons/{season_id}"),
                payload,
                &cookie,
                &csrf,
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }

    let first_episode_path =
        format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{first_episode_id}");
    let episode_archived = write(
        &app,
        "POST",
        &format!("{first_episode_path}/archive"),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(episode_archived.status(), StatusCode::OK);
    assert_eq!(body(episode_archived).await["series_version"], 15);
    let episode_draft = write(
        &app,
        "POST",
        &format!("{first_episode_path}/draft"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(episode_draft.status(), StatusCode::OK);
    assert_eq!(body(episode_draft).await["series_version"], 16);
    assert_eq!(
        write(
            &app,
            "DELETE",
            &first_episode_path,
            json!({"version":4}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );

    let republished = write(
        &app,
        "POST",
        &format!("/api/admin/series/{series_id}/publish"),
        json!({"version":17}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(republished.status(), StatusCode::OK);
    let republished = body(republished).await;
    assert_eq!(republished["version"], 18);
    assert_eq!(
        republished["seasons"][0]["episodes"][0]["id"],
        second_episode_id
    );
    assert_eq!(
        republished["seasons"][0]["episodes"][0]["status"],
        "published"
    );
}

// Catches delete confirmation flattening the hierarchy or using stale detail data.
#[tokio::test]
async fn series_delete_restores_all_media_when_a_later_stage_fails() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Stage rollback series").await;
    let series_id = created["id"].as_str().unwrap();
    let first = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let first_season = first["seasons"][0]["id"].as_str().unwrap();
    let first = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (series_id, first_season),
            2,
            1,
            "First",
        )
        .await,
    )
    .await;
    let first_episode = first["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let second = body(add_season(&app, &cookie, &csrf, series_id, 3, 2).await).await;
    let second_season = second["seasons"][1]["id"].as_str().unwrap();
    let second = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (series_id, second_season),
            4,
            1,
            "Second",
        )
        .await,
    )
    .await;
    let second_episode = second["seasons"][1]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let first_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, series_id.parse().unwrap(), poster.id).await;
    attach_episode_video(&db, first_episode, first_video.id).await;
    attach_episode_video(&db, second_episode, second_video.id).await;
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(FailSecondStage {
            stages: AtomicUsize::new(0),
        }),
    )
    .await
    .unwrap();

    let error =
        series_service::delete_series(&db, &storage.clone().into(), series_id.parse().unwrap(), 5)
            .await
            .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(response).await["code"], "media_delete_failed");
    assert!(
        series::Entity::find_by_id(series_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    for asset in [&poster, &first_video, &second_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_some()
        );
        assert!(root.as_ref().join(&asset.storage_key).is_file());
    }
}

#[tokio::test]
async fn season_delete_restores_all_videos_when_a_later_stage_fails() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Stage rollback season").await;
    let series_id = created["id"].as_str().unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 2, 1, "One").await).await;
    let first = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 3, 2, "Two").await).await;
    let second = hierarchy["seasons"][0]["episodes"][1]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let first_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, first, first_video.id).await;
    attach_episode_video(&db, second, second_video.id).await;
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(FailSecondStage {
            stages: AtomicUsize::new(0),
        }),
    )
    .await
    .unwrap();

    let error = series_service::delete_season(
        &db,
        &storage.clone().into(),
        series_service::DeleteSeasonCommand {
            series_id: series_id.parse().unwrap(),
            season_id: season_id.parse().unwrap(),
            expected_series_version: 4,
        },
    )
    .await
    .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(response).await["code"], "media_delete_failed");
    assert!(
        season::Entity::find_by_id(season_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(episode::Entity::find().count(&db).await.unwrap(), 2);
    for asset in [&first_video, &second_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_some()
        );
        assert!(root.as_ref().join(&asset.storage_key).is_file());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn episode_delete_reports_finish_failure_after_the_database_commit() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Finish failure episode").await;
    let series_id = created["id"].as_str().unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 2, 1, "One").await).await;
    let episode_id: Uuid = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, episode_id, video.id).await;
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(MakeOperationReadOnlyAfterStage {
            root: root.as_ref().to_owned(),
        }),
    )
    .await
    .unwrap();

    let error = series_service::delete_episode(
        &db,
        &storage.clone().into(),
        series_service::DeleteEpisodeCommand {
            series_id: series_id.parse().unwrap(),
            season_id: season_id.parse().unwrap(),
            episode_id,
            expected_episode_version: 1,
        },
    )
    .await
    .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body(response).await["code"],
        "media_delete_finalization_failed"
    );
    assert!(
        episode::Entity::find_by_id(episode_id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        media_asset::Entity::find_by_id(video.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    let operation = std::fs::read_dir(root.as_ref().join(".operations"))
        .unwrap()
        .next()
        .expect("the failed operation remains")
        .unwrap()
        .path();
    assert!(operation.join("manifest.json").is_file());
    assert!(operation.join("00000000.data").is_file());
    std::fs::set_permissions(operation, std::fs::Permissions::from_mode(0o700)).unwrap();
}

// Catches delete confirmation flattening the hierarchy or using stale detail data.
#[tokio::test]
async fn delete_impact_counts_the_live_hierarchy_and_delete_cleans_its_media() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Impact series").await;
    let series_id = created["id"].as_str().unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 2, 1, "First").await).await;
    let first_episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 3, 2, "Second").await).await;
    let second_episode_id = hierarchy["seasons"][0]["episodes"][1]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 4, 2).await).await;
    let second_season_id = hierarchy["seasons"][1]["id"].as_str().unwrap();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (series_id, second_season_id),
            5,
            1,
            "Third",
        )
        .await,
    )
    .await;
    let third_episode_id = hierarchy["seasons"][1]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png").await;
    let first_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let third_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_series_poster(&db, series_id.parse().unwrap(), poster.id).await;
    attach_episode_video(&db, first_episode_id, first_video.id).await;
    attach_episode_video(&db, second_episode_id, second_video.id).await;
    attach_episode_video(&db, third_episode_id, third_video.id).await;

    let impact = request(
        &app,
        "GET",
        &format!("/api/admin/series/{series_id}/delete-impact"),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(impact.status(), StatusCode::OK);
    assert_eq!(
        body(impact).await,
        json!({
            "name":"Impact series", "version":6, "season_count":2, "episode_count":3,
            "media_count":4
        })
    );
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/series/{series_id}"),
            json!({"version":5}),
            &cookie,
            &csrf
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{series_id}"),
        json!({"version":6}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body(deleted).await, json!({"deleted_media_count":4}));
    for asset in [&poster, &first_video, &second_video, &third_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.as_ref().join(&asset.storage_key).exists());
    }
}

#[tokio::test]
async fn season_delete_removes_multiple_episode_videos_synchronously() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Child cleanup").await;
    let series_id = created["id"].as_str().unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 2, 1, "One").await).await;
    let first = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 3, 2, "Two").await).await;
    let second = hierarchy["seasons"][0]["episodes"][1]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let first_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    let second_video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, first, first_video.id).await;
    attach_episode_video(&db, second, second_video.id).await;
    let season_impact = request(
        &app,
        "GET",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/delete-impact"),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(season_impact.status(), StatusCode::OK);
    assert_eq!(
        body(season_impact).await,
        json!({"display_name":"第 1 季","version":4,"season_count":1,"episode_count":2,"media_count":2})
    );
    let episode_impact = request(
        &app,
        "GET",
        &format!(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{first}/delete-impact"
        ),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(episode_impact.status(), StatusCode::OK);
    assert_eq!(
        body(episode_impact).await,
        json!({"display_name":"One","version":1,"season_count":0,"episode_count":1,"media_count":1})
    );
    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}"),
        json!({"version":4}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body(deleted).await, json!({"deleted_media_count":2}));
    for asset in [&first_video, &second_video] {
        assert!(
            media_asset::Entity::find_by_id(asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.as_ref().join(&asset.storage_key).exists());
    }
}

#[tokio::test]
async fn episode_delete_removes_its_video_synchronously() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Preview race").await;
    let series_id = created["id"].as_str().unwrap();
    let hierarchy = body(add_season(&app, &cookie, &csrf, series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap();
    let hierarchy =
        body(add_episode(&app, &cookie, &csrf, (series_id, season_id), 2, 1, "One").await).await;
    let episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap();
    let asset = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, episode_id.parse().unwrap(), asset.id).await;

    let impact = request(
        &app,
        "GET",
        &format!(
            "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/delete-impact"
        ),
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(impact.status(), StatusCode::OK);
    assert_eq!(
        body(impact).await,
        json!({"display_name":"One","version":1,"season_count":0,"episode_count":1,"media_count":1})
    );
    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body(deleted).await, json!({"deleted_media_count":1}));
    assert!(
        media_asset::Entity::find_by_id(asset.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!root.as_ref().join(asset.storage_key).exists());
}

// Catches malformed identifiers being confused with absent series resources.
#[tokio::test]
async fn invalid_and_missing_series_identifiers_are_mapped_consistently() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db, &config(root.as_ref())).await.unwrap();
    let (cookie, _) = credentials(&app).await;
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/series/not-a-uuid",
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
            &format!("/api/admin/series/{}", Uuid::new_v4()),
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

// Catches bypassing the archived-to-draft edit gate or deleting currently published content.
#[tokio::test]
async fn episode_and_series_archived_draft_transitions_gate_editing_and_deletion() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_series(&app, &cookie, &csrf, "Transition gates").await;
    let series_id = created["id"].as_str().unwrap().to_owned();
    let hierarchy = body(add_season(&app, &cookie, &csrf, &series_id, 1, 1).await).await;
    let season_id = hierarchy["seasons"][0]["id"].as_str().unwrap().to_owned();
    let hierarchy = body(
        add_episode(
            &app,
            &cookie,
            &csrf,
            (&series_id, &season_id),
            2,
            1,
            "Pilot",
        )
        .await,
    )
    .await;
    let episode_id = hierarchy["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4").await;
    attach_episode_video(&db, episode_id.parse().unwrap(), video.id).await;

    assert_eq!(
        write(
            &app,
            "POST",
            &format!(
                "/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}/publish"
            ),
            json!({"version":1}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
    let episode_path =
        format!("/api/admin/series/{series_id}/seasons/{season_id}/episodes/{episode_id}");
    assert_eq!(
        write(
            &app,
            "PATCH",
            &episode_path,
            json!({"version":2,"name":"Published edit"}),
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
            &episode_path,
            json!({"version":2}),
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
        &format!("{episode_path}/archive"),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    let archived = body(archived).await;
    assert_eq!(archived["episode"]["status"], "archived");
    assert_eq!(archived["episode"]["version"], 3);
    assert_eq!(archived["series_version"], 5);
    let repeated = write(
        &app,
        "POST",
        &format!("{episode_path}/archive"),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(repeated.status(), StatusCode::OK);
    assert_eq!(body(repeated).await["series_version"], 5);
    assert_eq!(
        write(
            &app,
            "PATCH",
            &episode_path,
            json!({"version":3,"name":"Archived edit"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let draft = write(
        &app,
        "POST",
        &format!("{episode_path}/draft"),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(draft.status(), StatusCode::OK);
    let draft = body(draft).await;
    assert_eq!(draft["episode"]["status"], "draft");
    assert_eq!(draft["episode"]["version"], 4);
    assert_eq!(draft["series_version"], 6);
    let edited = write(
        &app,
        "PATCH",
        &episode_path,
        json!({"version":4,"name":"  Editable again  ","duration_seconds":42}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(edited.status(), StatusCode::OK);
    let edited = body(edited).await;
    assert_eq!(edited["episode"]["name"], "Editable again");
    assert_eq!(edited["episode"]["version"], 5);
    assert_eq!(edited["series_version"], 7);
    assert_eq!(
        write(
            &app,
            "DELETE",
            &episode_path,
            json!({"version":5}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        series::Entity::find_by_id(series_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        8
    );

    let published = create_series(&app, &cookie, &csrf, "Published delete gate").await;
    let published_id = published["id"].as_str().unwrap().to_owned();
    db.execute_unprepared(&format!(
        "UPDATE series SET status='published' WHERE id='{published_id}'"
    ))
    .await
    .unwrap();
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/series/{published_id}"),
            json!({"version":1}),
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
        &format!("/api/admin/series/{published_id}/archive"),
        json!({"version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    assert_eq!(body(archived).await["version"], 2);
    assert_eq!(
        write(
            &app,
            "PATCH",
            &format!("/api/admin/series/{published_id}"),
            json!({"version":2,"name":"Archived edit"}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let draft = write(
        &app,
        "POST",
        &format!("/api/admin/series/{published_id}/draft"),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(draft.status(), StatusCode::OK);
    assert_eq!(body(draft).await["version"], 3);
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/series/{published_id}"),
            json!({"version":3}),
            &cookie,
            &csrf,
        )
        .await
        .status(),
        StatusCode::OK
    );
}
