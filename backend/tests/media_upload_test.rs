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
    entities::{file_cleanup_job, media_asset, movie},
    media::{
        AttachmentTarget, ChunkSource, LocalMediaStorage, MediaError, MediaKind, UploadPolicy,
        replace_attachment, store_new_asset,
    },
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    IntoActiveModel, Set,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nmovie-harbor-poster";
const JPEG: &[u8] = b"\xff\xd8\xff\xe0movie-harbor-poster";
const MP4: &[u8] = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2";
const OGG: &[u8] = b"OggS\x00\x02movie-harbor-video";

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_media_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
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

struct Chunks {
    chunks: Vec<Bytes>,
    index: usize,
    polls: Arc<AtomicUsize>,
    inspect_before_second: Option<PathBuf>,
}

impl Chunks {
    fn new(chunks: impl IntoIterator<Item = &'static [u8]>) -> (Self, Arc<AtomicUsize>) {
        let polls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                chunks: chunks.into_iter().map(Bytes::from_static).collect(),
                index: 0,
                polls: polls.clone(),
                inspect_before_second: None,
            },
            polls,
        )
    }

    fn inspect_incoming_before_second(mut self, root: &Path) -> Self {
        self.inspect_before_second = Some(root.join(".incoming"));
        self
    }
}

impl ChunkSource for Chunks {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            self.polls.fetch_add(1, Ordering::SeqCst);
            if self.index == 1
                && let Some(incoming) = &self.inspect_before_second
            {
                let sizes = std::fs::read_dir(incoming)
                    .unwrap()
                    .map(|entry| entry.unwrap().metadata().unwrap().len())
                    .collect::<Vec<_>>();
                assert_eq!(sizes, vec![self.chunks[0].len() as u64]);
            }
            let chunk = self.chunks.get(self.index).cloned();
            self.index += usize::from(chunk.is_some());
            Ok(chunk)
        })
    }
}

fn policy(max_bytes: u64) -> UploadPolicy {
    UploadPolicy::new(max_bytes, ["video/mp4", "video/webm"]).unwrap()
}

async fn database() -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("media_upload_test_{}", Uuid::new_v4().simple());
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

fn config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn draft_movie(db: &DatabaseConnection, poster_asset_id: Option<Uuid>) -> movie::Model {
    movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Draft".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(poster_asset_id),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn only_file(root: &Path, key: &str) -> bool {
    tokio::fs::metadata(root.join(key)).await.is_ok()
}

fn count_files(path: &Path) -> usize {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| if path.is_dir() { count_files(&path) } else { 1 })
        .sum()
}

async fn json_request(
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

async fn credentials(app: &Router) -> (String, String) {
    let login = json_request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        None,
        None,
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = json_request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let body: Value =
        serde_json::from_slice(&session.into_body().collect().await.unwrap().to_bytes()).unwrap();
    (cookie, body["csrf_token"].as_str().unwrap().to_owned())
}

fn multipart_request(
    path: String,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: &str,
) -> Request<Body> {
    let boundary = "movie-harbor-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"movie.mp4\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).into_bytes();
    body.extend_from_slice(MP4);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "harbor.test")
        .header("origin", origin)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        );
    if let Some(value) = cookie {
        builder = builder.header("cookie", value);
    }
    if let Some(value) = csrf {
        builder = builder.header("x-csrf-token", value);
    }
    let mut request = builder.body(Body::from(body)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    request
}

// Catches buffering the entire body before writing and using the user filename as a disk path.
#[tokio::test]
async fn chunks_are_written_incrementally_to_an_opaque_system_key() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, polls) = Chunks::new([&PNG[..8], &PNG[8..]]);
    let stored = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Poster,
            "cover.png",
            "image/png",
            &policy(1024),
            source.inspect_incoming_before_second(root.as_ref()),
        )
        .await
        .unwrap();

    assert_eq!(polls.load(Ordering::SeqCst), 3);
    assert_eq!(stored.byte_size, PNG.len() as i64);
    assert!(!stored.storage_key.contains("cover"));
    assert_eq!(stored.storage_key.split('/').count(), 3);
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&stored.storage_key))
            .await
            .unwrap(),
        PNG
    );
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches trusting filenames, declared MIME, extensions, or accepting unsupported formats.
#[tokio::test]
async fn traversal_spoofed_mime_and_unsupported_types_are_rejected() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();

    for name in ["../cover.png", "folder/cover.png", "..\\cover.png"] {
        let (source, _) = Chunks::new([PNG]);
        assert!(matches!(
            storage
                .store(
                    Uuid::new_v4(),
                    MediaKind::Poster,
                    name,
                    "image/png",
                    &policy(1024),
                    source
                )
                .await,
            Err(MediaError::InvalidFileName)
        ));
    }

    for (kind, name, mime, bytes) in [
        (MediaKind::Poster, "cover.png", "image/png", JPEG),
        (MediaKind::Poster, "cover.jpg", "image/jpeg", PNG),
        (
            MediaKind::Poster,
            "cover.gif",
            "image/gif",
            b"GIF89a".as_slice(),
        ),
        (MediaKind::Video, "movie.ogv", "video/ogg", OGG),
        (MediaKind::Video, "movie.mp4", "video/mp4", PNG),
    ] {
        let (source, _) = Chunks::new([bytes]);
        assert!(
            storage
                .store(Uuid::new_v4(), kind, name, mime, &policy(1024), source)
                .await
                .is_err()
        );
    }
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches enforcing only a Content-Length header or polling/buffering after the byte limit is known exceeded.
#[tokio::test]
async fn byte_limit_is_enforced_while_streaming_and_stops_polling() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, polls) = Chunks::new([&PNG[..8], &PNG[8..16], &PNG[16..]]);
    assert!(matches!(
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(12),
                source
            )
            .await,
        Err(MediaError::TooLarge)
    ));
    assert_eq!(polls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches switching the database reference before the cleanup job is durably recorded.
#[tokio::test]
async fn failed_replacement_preserves_old_reference_and_removes_new_artifact() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &storage,
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    file_cleanup_job::ActiveModel {
        id: Set(Uuid::new_v4()),
        media_asset_id: Set(old.id),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();

    let (new_source, _) = Chunks::new([JPEG]);
    assert!(
        replace_attachment(
            &db,
            &storage,
            AttachmentTarget::MoviePoster(movie.id),
            "new.jpg",
            "image/jpeg",
            &policy(1024),
            new_source,
        )
        .await
        .is_err()
    );

    let unchanged = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.poster_asset_id, Some(old.id));
    assert!(only_file(root.as_ref(), &old.storage_key).await);
    assert_eq!(media_asset::Entity::find().all(&db).await.unwrap().len(), 1);
    assert_eq!(count_files(root.as_ref()), 1);
}

// Catches media routes bypassing the content lifecycle's draft-only editing rule.
#[tokio::test]
async fn published_attachment_cannot_be_replaced_and_leaves_no_new_file() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &storage,
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let mut published = draft_movie(&db, Some(old.id)).await.into_active_model();
    published.status = Set("published".into());
    let published = published.update(&db).await.unwrap();

    let (new_source, _) = Chunks::new([JPEG]);
    assert!(
        replace_attachment(
            &db,
            &storage,
            AttachmentTarget::MoviePoster(published.id),
            "new.jpg",
            "image/jpeg",
            &policy(1024),
            new_source,
        )
        .await
        .is_err()
    );
    let unchanged = movie::Entity::find_by_id(published.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.poster_asset_id, Some(old.id));
    assert_eq!(count_files(root.as_ref()), 1);
}

// Catches deleting the old file before commit or forgetting to enqueue it after a successful switch.
#[tokio::test]
async fn successful_replacement_keeps_old_file_until_a_cleanup_job_runs() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &storage,
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;

    let (new_source, _) = Chunks::new([JPEG]);
    let new = replace_attachment(
        &db,
        &storage,
        AttachmentTarget::MoviePoster(movie.id),
        "new.jpg",
        "image/jpeg",
        &policy(1024),
        new_source,
    )
    .await
    .unwrap();

    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.poster_asset_id, Some(new.id));
    assert!(only_file(root.as_ref(), &old.storage_key).await);
    assert!(only_file(root.as_ref(), &new.storage_key).await);
    let jobs = file_cleanup_job::Entity::find().all(&db).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].media_asset_id, old.id);
}

// Catches omitting the route or bypassing the shared administrator middleware.
#[tokio::test]
async fn media_upload_routes_are_registered_and_require_authentication() {
    let db = database().await;
    let root = TempRoot::new();
    let movie = draft_movie(&db, None).await;
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let path = format!("/api/admin/media/movies/{}/video", movie.id);
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                None,
                None,
                "https://harbor.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = credentials(&app).await;
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                Some(&cookie),
                None,
                "https://harbor.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                Some(&cookie),
                Some(&csrf),
                "https://evil.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = app
        .oneshot(multipart_request(
            path,
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    let video = media_asset::Entity::find_by_id(updated.video_asset_id.unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(video.mime_type, "video/mp4");
    assert!(only_file(root.as_ref(), &video.storage_key).await);
}
