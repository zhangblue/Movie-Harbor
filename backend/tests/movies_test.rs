use axum::{
    Router,
    body::{Body, Bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    app,
    config::Config,
    entities::{genre, media_asset, movie, movie_genre},
    media::{
        AttachmentTarget, ChunkSource, LocalMediaStorage, MediaError, StorageEvent, StorageHooks,
        UploadPolicy, replace_attachment,
    },
    movies::service as movie_service,
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
use std::time::{Duration, Instant};
use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, oneshot};
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
    if make_regular_file {
        std::fs::write(&path, CONTENT).unwrap();
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
        checksum_sha256: Set(Some(format!("{:x}", Sha256::digest(CONTENT)))),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn associate(
    db: &DatabaseConnection,
    movie_id: &str,
    kind: &str,
    asset_id: Uuid,
    version: i64,
) -> Response {
    let column = match kind {
        "poster" => "poster_asset_id",
        "video" => "video_asset_id",
        _ => panic!("unexpected media slot"),
    };
    let result = db
        .execute_unprepared(&format!(
            "UPDATE movie SET {column}='{asset_id}', version=version+1 WHERE id='{movie_id}' AND version={version}"
        ))
        .await
        .unwrap();
    assert_eq!(result.rows_affected(), 1);
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(json!({"version": version + 1}).to_string()))
        .unwrap()
}

struct FailSecondStage {
    stages: AtomicUsize,
}

const LOCK_ORDER_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

struct PausedPng {
    started: Option<oneshot::Sender<()>>,
    release: Option<oneshot::Receiver<()>>,
    finished: bool,
}

impl ChunkSource for PausedPng {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        let started = self.started.take();
        let release = self.release.take();
        let finished = self.finished;
        self.finished = true;
        Box::pin(async move {
            if finished {
                return Ok(None);
            }
            started
                .expect("first chunk signals start")
                .send(())
                .unwrap();
            release
                .expect("first chunk waits for release")
                .await
                .unwrap();
            Ok(Some(Bytes::from_static(LOCK_ORDER_PNG)))
        })
    }
}

struct RemovalLockSignal {
    entered: Arc<Notify>,
}

impl StorageHooks for RemovalLockSignal {
    fn on_event(&self, event: &StorageEvent) -> io::Result<()> {
        if matches!(event, StorageEvent::BeforeRemovalLock) {
            self.entered.notify_one();
        }
        Ok(())
    }
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

async fn run_upload_delete_lock_interleaving(delete_same_movie: bool) {
    let db = database().await;
    let root = TempRoot::new();
    let old_upload_asset = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let upload_movie = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Upload target".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(Some(old_upload_asset.id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let delete_asset = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    let delete_movie = if delete_same_movie {
        upload_movie.clone()
    } else {
        movie::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set("Delete target".into()),
            synopsis: Set(String::new()),
            video_asset_id: Set(Some(delete_asset.id)),
            status: Set("draft".into()),
            version: Set(1),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap()
    };
    let removal_entered = Arc::new(Notify::new());
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(RemovalLockSignal {
            entered: removal_entered.clone(),
        }),
    )
    .await
    .unwrap();
    let (source_started_tx, source_started_rx) = oneshot::channel();
    let (source_release_tx, source_release_rx) = oneshot::channel();
    let upload_db = db.clone();
    let upload_storage = storage.clone();
    let upload_id = upload_movie.id;
    let mut upload = tokio::spawn(async move {
        replace_attachment(
            &upload_db,
            &upload_storage,
            AttachmentTarget::MoviePoster {
                id: upload_id,
                version: 1,
            },
            "replacement.png",
            "image/png",
            &UploadPolicy::new(4096, ["video/mp4", "video/webm"]).unwrap(),
            PausedPng {
                started: Some(source_started_tx),
                release: Some(source_release_rx),
                finished: false,
            },
        )
        .await
    });
    source_started_rx.await.unwrap();
    let delete_db = db.clone();
    let delete_storage = storage;
    let delete_id = delete_movie.id;
    let mut deletion = tokio::spawn(async move {
        movie_service::delete(&delete_db, &delete_storage, delete_id, 1).await
    });
    removal_entered.notified().await;
    source_release_tx.send(()).unwrap();

    let completed = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(&mut upload, &mut deletion)
    })
    .await;
    let (uploaded, deleted) = match completed {
        Ok(results) => results,
        Err(error) => {
            upload.abort();
            deletion.abort();
            let _ = upload.await;
            let _ = deletion.await;
            panic!("upload/delete lock interleaving did not complete: {error}");
        }
    };
    let uploaded = uploaded.unwrap().unwrap();
    assert!(root.as_ref().join(&uploaded.storage_key).is_file());
    let current_upload_movie = movie::Entity::find_by_id(upload_movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current_upload_movie.version, 2);
    assert_eq!(current_upload_movie.poster_asset_id, Some(uploaded.id));
    if delete_same_movie {
        assert!(matches!(
            deleted.unwrap(),
            Err(movie_service::MovieError::Conflict)
        ));
    } else {
        assert_eq!(deleted.unwrap().unwrap().deleted_media_count, 1);
        assert!(
            movie::Entity::find_by_id(delete_movie.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            media_asset::Entity::find_by_id(delete_asset.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.as_ref().join(delete_asset.storage_key).exists());
    }
}

#[tokio::test]
async fn upload_and_delete_of_the_same_movie_complete_without_cross_system_deadlock() {
    run_upload_delete_lock_interleaving(true).await;
}

#[tokio::test]
async fn upload_and_delete_of_different_movies_complete_with_consistent_files() {
    run_upload_delete_lock_interleaving(false).await;
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

// Catches accidentally retaining the arbitrary asset-ID association API.
#[tokio::test]
async fn removed_arbitrary_media_association_routes_return_not_found() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Media movie").await;
    let id = created["id"].as_str().unwrap();
    let response = write(
        &app,
        "PUT",
        &format!("/api/admin/movies/{id}/poster"),
        json!({"asset_id":Uuid::new_v4().to_string(), "version":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
        associate(&db, id, "poster", poster.id, 1).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, id, "video", inaccessible_video.id, 2,)
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
        associate(&db, invalid_key_id, "poster", poster.id, 1,)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, invalid_key_id, "video", unsafe_video.id, 2,)
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
        associate(&db, missing_file_id, "poster", poster.id, 1,)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, missing_file_id, "video", absent_video.id, 2,)
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
        associate(&db, wrong_mime_id, "poster", poster.id, 1,)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, wrong_mime_id, "video", wrong_mime_video.id, 2,)
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
        associate(&db, id, "poster", poster.id, 1).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, id, "video", video.id, 2).await.status(),
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
        associate(&db, id, "poster", poster.id, 1).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, id, "video", video.id, 2).await.status(),
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
        StatusCode::OK
    );
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_none()
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
        StatusCode::OK
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

// Catches a partial media stage deleting content or leaving the first file quarantined.
#[tokio::test]
async fn delete_restores_staged_movie_media_when_a_later_stage_fails() {
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
    let poster_response = associate(&db, id, "poster", poster.id, 1).await;
    assert_eq!(poster_response.status(), StatusCode::OK);
    let video_response = associate(&db, id, "video", video.id, 2).await;
    assert_eq!(video_response.status(), StatusCode::OK);
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(FailSecondStage {
            stages: AtomicUsize::new(0),
        }),
    )
    .await
    .unwrap();
    let error = movie_service::delete(&db, &storage, id.parse().unwrap(), 3)
        .await
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(response).await["code"], "media_delete_failed");
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        media_asset::Entity::find_by_id(poster.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        media_asset::Entity::find_by_id(video.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(root.as_ref().join(poster.storage_key).is_file());
    assert!(root.as_ref().join(video.storage_key).is_file());
}

#[tokio::test]
async fn delete_restores_movie_media_when_the_database_transaction_fails() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Database rollback").await;
    let id = created["id"].as_str().unwrap();
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&db, id, "video", video.id, 1).await.status(),
        StatusCode::OK
    );
    db.execute_unprepared(
        "CREATE FUNCTION reject_media_asset_delete() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN RAISE EXCEPTION 'forced media asset delete failure'; END $$; \
         CREATE TRIGGER reject_media_asset_delete BEFORE DELETE ON media_asset \
         FOR EACH ROW EXECUTE FUNCTION reject_media_asset_delete()",
    )
    .await
    .unwrap();

    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/movies/{id}"),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(deleted).await["code"], "media_delete_failed");
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        media_asset::Entity::find_by_id(video.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(root.as_ref().join(video.storage_key).is_file());
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

#[cfg(unix)]
#[tokio::test]
async fn delete_reports_finish_failure_after_the_database_commit() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Finish failure").await;
    let id = created["id"].as_str().unwrap();
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&db, id, "video", video.id, 1).await.status(),
        StatusCode::OK
    );
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(MakeOperationReadOnlyAfterStage {
            root: root.as_ref().to_owned(),
        }),
    )
    .await
    .unwrap();

    let error = movie_service::delete(&db, &storage, id.parse().unwrap(), 2)
        .await
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(response).await["code"], "media_delete_failed");
    assert!(
        movie::Entity::find_by_id(id.parse::<Uuid>().unwrap())
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
    assert!(!root.as_ref().join(video.storage_key).exists());
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

// Catches confirmation data being inferred from a stale detail response and shared media being
// reported as files that deletion will remove.
#[tokio::test]
async fn delete_impact_and_delete_cover_all_movie_media() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let first = create_movie(&app, &cookie, &csrf, "Impact movie").await;
    let poster = create_asset(&db, root.as_ref(), "poster", "image/png", true).await;
    let video = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&db, first["id"].as_str().unwrap(), "poster", poster.id, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        associate(&db, first["id"].as_str().unwrap(), "video", video.id, 2)
            .await
            .status(),
        StatusCode::OK
    );
    let impact = request(
        &app,
        "GET",
        &format!(
            "/api/admin/movies/{}/delete-impact",
            first["id"].as_str().unwrap()
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
        json!({
            "name":"Impact movie", "version":3, "season_count":0, "episode_count":0,
            "media_count":2
        })
    );
    assert_eq!(
        write(
            &app,
            "DELETE",
            &format!("/api/admin/movies/{}", first["id"].as_str().unwrap()),
            json!({"version":2}),
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
        &format!("/api/admin/movies/{}", first["id"].as_str().unwrap()),
        json!({"version":3}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body(deleted).await, json!({"deleted_media_count":2}));
    for asset in [&poster, &video] {
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

// Catches a pre-commit storage permission failure deleting content or media metadata.
#[cfg(unix)]
#[tokio::test]
async fn delete_preserves_content_when_media_staging_is_not_permitted() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let created = create_movie(&app, &cookie, &csrf, "Pending cleanup").await;
    let asset = create_asset(&db, root.as_ref(), "video", "video/mp4", true).await;
    assert_eq!(
        associate(&db, created["id"].as_str().unwrap(), "video", asset.id, 1)
            .await
            .status(),
        StatusCode::OK
    );
    let parent = root
        .as_ref()
        .join(&asset.storage_key)
        .parent()
        .unwrap()
        .to_owned();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o500)).unwrap();
    let deleted = write(
        &app,
        "DELETE",
        &format!("/api/admin/movies/{}", created["id"].as_str().unwrap()),
        json!({"version":2}),
        &cookie,
        &csrf,
    )
    .await;
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(deleted.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let result = body(deleted).await;
    assert_eq!(result["code"], "media_delete_failed");
    assert!(
        movie::Entity::find_by_id(created["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        media_asset::Entity::find_by_id(asset.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(root.as_ref().join(asset.storage_key).is_file());
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
