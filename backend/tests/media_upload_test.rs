use axum::{
    Router,
    body::{Body, Bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use image::{ExtendedColorType, ImageEncoder};
use movie_harbor_api::{
    app,
    config::Config,
    entities::{file_cleanup_job, media_asset, movie},
    media::{
        AttachmentTarget, ChunkSource, LocalMediaStorage, MediaError, MediaKind, StorageEvent,
        StorageHooks, UploadPolicy, replace_attachment, store_new_asset,
    },
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    IntoActiveModel, Set,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, SystemTime};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

fn jpeg() -> &'static [u8] {
    static BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BYTES.get_or_init(|| {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .write_image(&[24, 48, 96], 1, 1, ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    })
}

fn decode_base64(input: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("invalid fixture base64"),
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
            accumulator &= (1_u32 << bits) - 1;
        }
    }
    output
}

fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(payload.len() + 8);
    result.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
    result.extend_from_slice(kind);
    result.extend_from_slice(payload);
    result
}

fn incomplete_mp4() -> Vec<u8> {
    let mut ftyp = b"isom\0\0\x02\0isommp42".to_vec();
    ftyp = atom(b"ftyp", &ftyp);
    let hdlr = atom(b"hdlr", b"\0\0\0\0\0\0\0\0vide\0\0\0\0");
    let mut sample_payload = vec![0; 78];
    sample_payload.extend(atom(b"avcC", &[1, 66, 0, 30, 0xff]));
    let sample = atom(b"avc1", &sample_payload);
    let mut stsd_payload = vec![0; 8];
    stsd_payload[7] = 1;
    stsd_payload.extend_from_slice(&sample);
    let stsd = atom(b"stsd", &stsd_payload);
    let mut stsz_payload = vec![0; 12];
    stsz_payload[7] = 1;
    stsz_payload[11] = 1;
    let stsz = atom(b"stsz", &stsz_payload);
    let mut stbl_payload = stsd;
    stbl_payload.extend_from_slice(&stsz);
    let stbl = atom(b"stbl", &stbl_payload);
    let minf = atom(b"minf", &stbl);
    let mut mdia_payload = hdlr;
    mdia_payload.extend_from_slice(&minf);
    let mdia = atom(b"mdia", &mdia_payload);
    let trak = atom(b"trak", &mdia);
    let moov = atom(b"moov", &trak);
    let mdat = atom(b"mdat", &[1]);
    ftyp.extend_from_slice(&moov);
    ftyp.extend_from_slice(&mdat);
    ftyp
}

fn valid_mp4() -> Vec<u8> {
    decode_base64(
        "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMObW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAyDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAfZYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAKDAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM+AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACi21kYXQAAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQK8mKAAKe+",
    )
}

fn valid_webp() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
        .write_image(&[24, 48, 96], 1, 1, ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() < 127);
    let mut result = id.to_vec();
    result.push(0x80 | payload.len() as u8);
    result.extend_from_slice(payload);
    result
}

fn structured_webm() -> Vec<u8> {
    let doc_type = ebml_element(&[0x42, 0x82], b"webm");
    let header = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &doc_type);
    let track_number = ebml_element(&[0xd7], &[1]);
    let track_type = ebml_element(&[0x83], &[1]);
    let codec = ebml_element(&[0x86], b"V_VP9");
    let mut entry_payload = track_number;
    entry_payload.extend(track_type);
    entry_payload.extend(codec);
    let entry = ebml_element(&[0xae], &entry_payload);
    let tracks = ebml_element(&[0x16, 0x54, 0xae, 0x6b], &entry);
    let cluster = ebml_element(
        &[0x1f, 0x43, 0xb6, 0x75],
        &ebml_element(&[0xa3], &[0x81, 0, 0, 0, 0x82]),
    );
    let mut segment_payload = tracks;
    segment_payload.extend(cluster);
    let segment = ebml_element(&[0x18, 0x53, 0x80, 0x67], &segment_payload);
    [header, segment].concat()
}

fn valid_webm() -> Vec<u8> {
    decode_base64(concat!(
        "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH1EU2bdLpNu4tTq4QV",
        "SalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHf7AEAAAAAAABZ",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxM",
        "YXZmNjMuMS4xMDFEiYhARAAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WITi+TBaEj/oCcgQAitZyDdW5k",
        "iIEAhoVWX1ZQOYOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5z",
        "c59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PZY8CLY8WITi+TBaEj/oBnyKRFo4dFTkNP",
        "REVSRIeXTGF2YzYzLjEuMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0MDAw",
        "MDAwMAAfQ7Z1peeBAKOggQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAAcU7trkbuPs4EAt4r3",
        "gQHxggG18IED"
    ))
}

fn ogg_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn ogg_page(serial: u32, sequence: u32, header_type: u8, packet: &[u8]) -> Vec<u8> {
    let mut page = b"OggS".to_vec();
    page.extend_from_slice(&[0, header_type]);
    page.extend_from_slice(&0_u64.to_le_bytes());
    page.extend_from_slice(&serial.to_le_bytes());
    page.extend_from_slice(&sequence.to_le_bytes());
    page.extend_from_slice(&0_u32.to_le_bytes());
    page.push(1);
    page.push(packet.len() as u8);
    page.extend_from_slice(packet);
    let checksum = ogg_crc(&page).to_le_bytes();
    page[22..26].copy_from_slice(&checksum);
    page
}

fn valid_ogg_video() -> Vec<u8> {
    let mut identification = vec![0; 42];
    identification[..7].copy_from_slice(b"\x80theora");
    identification[7..10].copy_from_slice(&[3, 2, 1]);
    identification[10..12].copy_from_slice(&1_u16.to_be_bytes());
    identification[12..14].copy_from_slice(&1_u16.to_be_bytes());
    identification[14..17].copy_from_slice(&[0, 0, 16]);
    identification[17..20].copy_from_slice(&[0, 0, 16]);
    identification[22..26].copy_from_slice(&30_u32.to_be_bytes());
    identification[26..30].copy_from_slice(&1_u32.to_be_bytes());
    identification[30..33].copy_from_slice(&[0, 0, 1]);
    identification[33..36].copy_from_slice(&[0, 0, 1]);
    let mut comment = b"\x81theora".to_vec();
    comment.extend(2_u32.to_le_bytes());
    comment.extend(b"mh");
    comment.extend(0_u32.to_le_bytes());
    let mut setup = b"\x82theora".to_vec();
    setup.extend([0x55; 16]);
    [
        ogg_page(1, 0, 2, &identification),
        ogg_page(1, 1, 0, &comment),
        ogg_page(1, 2, 0, &setup),
        ogg_page(1, 3, 0, b"\x00\x01"),
    ]
    .concat()
}

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

    fn bytes(bytes: Vec<u8>) -> (Self, Arc<AtomicUsize>) {
        let polls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                chunks: vec![Bytes::from(bytes)],
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

struct PausingChunks {
    first: bool,
}

impl ChunkSource for PausingChunks {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            if self.first {
                self.first = false;
                Ok(Some(Bytes::from_static(PNG)))
            } else {
                std::future::pending().await
            }
        })
    }
}

struct FailFirstUnlink {
    failed: AtomicBool,
}

impl StorageHooks for FailFirstUnlink {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::BeforeUnlink(_))
            && !self.failed.swap(true, Ordering::SeqCst)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected unlink failure with sensitive detail",
            ));
        }
        Ok(())
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
        max_upload_bytes: 4096,
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

#[cfg(unix)]
fn write_pending_marker(root: &Path, id: Uuid, key: &str, owner: &Path) -> PathBuf {
    let metadata = std::fs::metadata(owner).unwrap();
    let bytes = std::fs::read(owner).unwrap();
    let marker = root
        .join(".incoming")
        .join(format!("{}.pending", id.simple()));
    std::fs::write(
        &marker,
        serde_json::to_vec(&json!({
            "version": 1,
            "storage_key": key,
            "device": metadata.dev(),
            "inode": metadata.ino(),
            "byte_size": metadata.len(),
            "checksum_sha256": format!("{:x}", Sha256::digest(&bytes)),
        }))
        .unwrap(),
    )
    .unwrap();
    marker
}

fn make_stale(path: &Path) {
    let file = std::fs::File::open(path).unwrap();
    file.set_times(
        std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7200)),
    )
    .unwrap();
}

#[derive(Default)]
struct RecordingHooks {
    events: Mutex<Vec<StorageEvent>>,
}

impl StorageHooks for RecordingHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}

enum AdversarialAction {
    Collision,
    ReplaceParentWithSymlink(PathBuf),
    ReplaceSourceWithSymlink(PathBuf),
}

struct AdversarialHooks {
    root: PathBuf,
    action: AdversarialAction,
    fired: AtomicBool,
}

impl StorageHooks for AdversarialHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if !matches!(event, StorageEvent::BeforePromote(_))
            || self.fired.swap(true, Ordering::SeqCst)
        {
            return Ok(());
        }
        let StorageEvent::BeforePromote(key) = event else {
            unreachable!()
        };
        let target = self.root.join(key);
        match &self.action {
            AdversarialAction::Collision => std::fs::write(target, b"collision"),
            AdversarialAction::ReplaceParentWithSymlink(outside) => {
                let parent = target.parent().unwrap();
                let moved = parent.with_extension("moved");
                std::fs::rename(parent, &moved)?;
                std::os::unix::fs::symlink(outside, parent)?;
                std::fs::write(outside.join(target.file_name().unwrap()), b"outside")
            }
            AdversarialAction::ReplaceSourceWithSymlink(outside) => {
                let part = std::fs::read_dir(self.root.join(".incoming"))?
                    .map(|entry| entry.map(|entry| entry.path()))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .find(|path| path.extension() == Some(std::ffi::OsStr::new("part")))
                    .ok_or_else(|| std::io::Error::other("missing upload part"))?;
                std::fs::remove_file(&part)?;
                std::os::unix::fs::symlink(outside, part)
            }
        }
    }
}

struct PauseAfterDatabaseCommit {
    commits: AtomicUsize,
}

impl StorageHooks for PauseAfterDatabaseCommit {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::DatabaseCommitted(_)) {
            self.commits.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
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
    body.extend_from_slice(&valid_mp4());
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

fn raw_multipart_request(
    path: String,
    cookie: &str,
    csrf: &str,
    boundary: &str,
    body: Vec<u8>,
) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap();
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
    let incoming = std::fs::read_dir(root.as_ref().join(".incoming"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(incoming.len(), 1);
    assert!(incoming[0].ends_with(".pending"));
}

// Catches replacing a destination that appears after a preflight existence check.
#[tokio::test]
async fn promotion_is_atomic_and_never_overwrites_a_collision() {
    let root = TempRoot::new();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::Collision,
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                id,
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.as_ref().join(key)).unwrap(),
        b"collision"
    );
}

// Catches path-based rename following a parent changed to an external symlink mid-operation.
#[cfg(unix)]
#[tokio::test]
async fn promotion_does_not_follow_a_parent_symlink_substituted_during_commit() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::ReplaceParentWithSymlink(outside.as_ref().to_owned()),
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let file_name = format!("{}.png", simple);
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                id,
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(outside.as_ref().join(file_name)).unwrap(),
        b"outside"
    );
}

// Catches promotion renaming an attacker-substituted source symlink after validating another inode.
#[cfg(unix)]
#[tokio::test]
async fn promotion_rejects_a_source_part_replaced_by_an_external_symlink() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let outside_file = outside.as_ref().join("external.png");
    std::fs::write(&outside_file, PNG).unwrap();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::ReplaceSourceWithSymlink(outside_file.clone()),
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source,
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(outside_file).unwrap(), PNG);
}

// Catches omitting a file/directory fsync or syncing cross-directory rename endpoints out of order.
#[tokio::test]
async fn durable_promotion_syncs_created_parents_source_and_destination_in_order() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(RecordingHooks::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);
    let asset = store_new_asset(
        &db,
        &storage,
        MediaKind::Poster,
        "cover.png",
        "image/png",
        &policy(1024),
        source,
    )
    .await
    .unwrap();
    let parent = asset.storage_key.rsplit_once('/').unwrap().0.to_owned();
    let events = hooks.events.lock().unwrap().clone();

    let find = |predicate: &dyn Fn(&StorageEvent) -> bool| {
        events
            .iter()
            .position(predicate)
            .expect("required durability event")
    };
    let root_sync = find(&|event| event == &StorageEvent::DirectorySynced(String::new()));
    let kind_sync = find(&|event| event == &StorageEvent::DirectorySynced("poster".into()));
    let temp_sync =
        find(&|event| matches!(event, StorageEvent::FileSynced(name) if name.ends_with(".part")));
    let marker_sync = find(
        &|event| matches!(event, StorageEvent::FileSynced(name) if name.ends_with(".pending")),
    );
    let promote = find(&|event| matches!(event, StorageEvent::Promoted(_)));
    let destination_sync = find(&|event| event == &StorageEvent::DirectorySynced(parent.clone()));
    let source_sync_after = events
        .iter()
        .enumerate()
        .skip(promote + 1)
        .find(|(_, event)| *event == &StorageEvent::DirectorySynced(".incoming".into()))
        .map(|(index, _)| index)
        .expect("source directory sync after rename");
    assert!(root_sync < kind_sync && kind_sync < temp_sync);
    assert!(temp_sync < marker_sync && marker_sync < promote);
    assert!(promote < destination_sync && destination_sync < source_sync_after);
}

// Catches cancellation skipping explicit async error cleanup and leaking a part file.
#[tokio::test]
async fn cancelling_an_upload_removes_its_incoming_part_file() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let task_storage = storage.clone();
    let task = tokio::spawn(async move {
        task_storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                PausingChunks { first: true },
            )
            .await
    });
    for _ in 0..100 {
        if std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part")
            })
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches an unsafe startup sweep deleting fresh/in-progress files or scanning formal media.
#[tokio::test]
async fn recovery_sweeps_only_stale_incoming_part_files() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let incoming = root.as_ref().join(".incoming");
    let stale = incoming.join(format!("{}.part", Uuid::new_v4().simple()));
    let fresh = incoming.join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&stale, b"stale").unwrap();
    std::fs::write(&fresh, b"fresh").unwrap();
    let stale_file = std::fs::File::open(&stale).unwrap();
    stale_file
        .set_times(
            std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7200)),
        )
        .unwrap();
    let formal = root.as_ref().join("poster/not-a-controlled-file");
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, b"formal").unwrap();

    movie_harbor_api::media::cleanup::recover_uploads(&db, &storage, Duration::from_secs(3600))
        .await
        .unwrap();

    assert!(!stale.exists());
    assert!(fresh.exists());
    assert!(formal.exists());
}

// Catches one truncated marker aborting startup recovery or preventing safe entries from sweeping.
#[tokio::test]
async fn invalid_recovery_markers_are_retained_without_aborting_the_sweep() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let invalid = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.pending", Uuid::new_v4().simple()));
    let stale_part = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&invalid, b"{truncated").unwrap();
    std::fs::write(&stale_part, b"stale").unwrap();
    make_stale(&invalid);
    make_stale(&stale_part);

    movie_harbor_api::media::cleanup::recover_uploads(&db, &storage, Duration::ZERO)
        .await
        .unwrap();

    assert!(invalid.exists());
    assert!(!stale_part.exists());
}

// Catches crash-before-promotion recovery deleting an unrelated destination collision.
#[cfg(unix)]
#[tokio::test]
async fn recovery_requires_marker_identity_before_deleting_a_formal_file() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, b"unrelated collision").unwrap();
    let owner = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&owner, PNG).unwrap();
    let marker = write_pending_marker(root.as_ref(), id, &key, &owner);
    make_stale(&marker);

    movie_harbor_api::media::cleanup::recover_uploads(&db, &storage, Duration::ZERO)
        .await
        .unwrap();

    assert_eq!(std::fs::read(formal).unwrap(), b"unrelated collision");
    assert!(
        marker.exists(),
        "unproven marker must remain for investigation"
    );
}

// Catches a marker being repointed to a different resource despite matching file metadata.
#[cfg(unix)]
#[tokio::test]
async fn recovery_marker_name_must_match_its_formal_resource_key() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let formal_id = Uuid::new_v4();
    let simple = formal_id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, PNG).unwrap();
    let marker = write_pending_marker(root.as_ref(), Uuid::new_v4(), &key, &formal);
    make_stale(&marker);

    movie_harbor_api::media::cleanup::recover_uploads(&db, &storage, Duration::ZERO)
        .await
        .unwrap();

    assert!(formal.exists());
    assert!(marker.exists());
}

// Catches a worker that only recovers once at startup and never revisits initially fresh parts.
#[tokio::test]
async fn cleanup_worker_periodically_revisits_initially_fresh_parts() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(RecordingHooks::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let fresh = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&fresh, b"fresh").unwrap();
    tokio::time::pause();
    let worker = movie_harbor_api::media::cleanup::spawn(db, storage);
    for _ in 0..500 {
        if hooks
            .events
            .lock()
            .unwrap()
            .contains(&StorageEvent::RecoveryCycleCompleted)
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        hooks
            .events
            .lock()
            .unwrap()
            .contains(&StorageEvent::RecoveryCycleCompleted),
        "worker did not finish its initial recovery cycle"
    );
    assert!(fresh.exists());
    make_stale(&fresh);
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(301)).await;
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        if !fresh.exists() {
            break;
        }
    }
    worker.abort();
    assert!(!fresh.exists());
}

// Catches a DB failure plus cleanup failure silently leaking a promoted formal file.
#[tokio::test]
async fn failed_post_promotion_database_path_is_recoverable_on_startup() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(FailFirstUnlink {
        failed: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);
    assert!(matches!(
        replace_attachment(
            &db,
            &storage,
            AttachmentTarget::MoviePoster(Uuid::new_v4()),
            "cover.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await,
        Err(MediaError::TargetNotFound)
    ));
    assert!(
        count_files(root.as_ref()) >= 2,
        "formal file and recovery marker remain"
    );

    let recovered = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    movie_harbor_api::media::cleanup::recover_uploads(&db, &recovered, Duration::from_secs(0))
        .await
        .unwrap();
    assert_eq!(count_files(root.as_ref()), 0);
}

// Catches cancellation after an autocommit reached PostgreSQL deleting its committed file.
#[tokio::test]
async fn cancellation_after_asset_insert_commit_preserves_file_for_reconciliation() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(PauseAfterDatabaseCommit {
        commits: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let task_db = db.clone();
    let task_storage = storage.clone();
    let (source, _) = Chunks::new([PNG]);
    let task = tokio::spawn(async move {
        store_new_asset(
            &task_db,
            &task_storage,
            MediaKind::Poster,
            "cover.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await
    });
    while hooks.commits.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let asset = media_asset::Entity::find().one(&db).await.unwrap().unwrap();
    assert!(root.as_ref().join(&asset.storage_key).is_file());
    assert!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".pending"))
    );
    movie_harbor_api::media::cleanup::recover_uploads(&db, &storage, Duration::ZERO)
        .await
        .unwrap();
    assert!(root.as_ref().join(asset.storage_key).is_file());
}

// Catches cancellation after replacement commit deleting the newly referenced formal file.
#[tokio::test]
async fn cancellation_after_replacement_commit_preserves_new_reference_and_file() {
    let db = database().await;
    let root = TempRoot::new();
    let base_storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &base_storage,
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let movie_id = movie.id;
    let hooks = Arc::new(PauseAfterDatabaseCommit {
        commits: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let task_db = db.clone();
    let task_storage = storage.clone();
    let (source, _) = Chunks::new([PNG]);
    let task = tokio::spawn(async move {
        replace_attachment(
            &task_db,
            &task_storage,
            AttachmentTarget::MoviePoster(movie_id),
            "new.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await
    });
    while hooks.commits.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let updated = movie::Entity::find_by_id(movie_id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    let new_id = updated.poster_asset_id.unwrap();
    assert_ne!(new_id, old.id);
    let new_asset = media_asset::Entity::find_by_id(new_id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert!(root.as_ref().join(new_asset.storage_key).is_file());
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
        (MediaKind::Poster, "cover.png", "image/png", jpeg()),
        (MediaKind::Poster, "cover.jpg", "image/jpeg", PNG),
        (
            MediaKind::Poster,
            "cover.gif",
            "image/gif",
            b"GIF89a".as_slice(),
        ),
        (
            MediaKind::Video,
            "movie.ogv",
            "video/ogg",
            b"OggS\x00\x02movie-harbor-video".as_slice(),
        ),
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

// Catches accepting a forged/truncated magic prefix instead of a complete playable container.
#[tokio::test]
async fn structured_validation_accepts_valid_minimal_files_and_rejects_forged_containers() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy =
        UploadPolicy::new(1024 * 1024, ["video/mp4", "video/webm", "video/ogg"]).unwrap();

    for (kind, name, mime, bytes) in [
        (MediaKind::Poster, "valid.png", "image/png", PNG.to_vec()),
        (
            MediaKind::Poster,
            "valid.jpg",
            "image/jpeg",
            jpeg().to_vec(),
        ),
        (MediaKind::Poster, "valid.webp", "image/webp", valid_webp()),
        (MediaKind::Video, "valid.mp4", "video/mp4", valid_mp4()),
        (MediaKind::Video, "valid.webm", "video/webm", valid_webm()),
        (
            MediaKind::Video,
            "valid.ogv",
            "video/ogg",
            valid_ogg_video(),
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        storage
            .store(Uuid::new_v4(), kind, name, mime, &video_policy, source)
            .await
            .unwrap_or_else(|error| panic!("valid fixture {name} rejected: {error}"));
    }

    let audio_ogg = [ogg_page(2, 0, 2, b"\x01vorbis\0"), ogg_page(2, 1, 0, b"\0")].concat();
    let mut invalid_avcc = valid_mp4();
    let avcc = invalid_avcc
        .windows(4)
        .position(|window| window == b"avcC")
        .unwrap();
    invalid_avcc[avcc + 9] &= 0xe0;
    let mut invalid_sample_offset = valid_mp4();
    let stco = invalid_sample_offset
        .windows(4)
        .position(|window| window == b"stco")
        .unwrap();
    invalid_sample_offset[stco + 12..stco + 16].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut mismatched_webm_track = structured_webm();
    let block_track = mismatched_webm_track
        .windows(3)
        .rposition(|window| window == [0xa3, 0x85, 0x81])
        .unwrap()
        + 2;
    mismatched_webm_track[block_track] = 0x82;
    let mut identification = vec![0; 42];
    identification[..7].copy_from_slice(b"\x80theora");
    identification[7..10].copy_from_slice(&[3, 2, 1]);
    identification[10..12].copy_from_slice(&1_u16.to_be_bytes());
    identification[12..14].copy_from_slice(&1_u16.to_be_bytes());
    let bare_theora_headers = [
        ogg_page(3, 0, 2, &identification),
        ogg_page(3, 1, 0, b"\x81theora"),
        ogg_page(3, 2, 0, b"\x82theora"),
        ogg_page(3, 3, 0, b"\0"),
    ]
    .concat();
    for (kind, name, mime, bytes) in [
        (
            MediaKind::Poster,
            "forged.png",
            "image/png",
            b"\x89PNG\r\n\x1a\nnot-a-png".to_vec(),
        ),
        (
            MediaKind::Poster,
            "truncated.jpg",
            "image/jpeg",
            b"\xff\xd8\xff\xe0\0\x10".to_vec(),
        ),
        (
            MediaKind::Poster,
            "forged.webp",
            "image/webp",
            b"RIFF\x04\0\0\0WEBP".to_vec(),
        ),
        (
            MediaKind::Video,
            "magic-only.mp4",
            "video/mp4",
            b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2".to_vec(),
        ),
        (
            MediaKind::Video,
            "unmapped-sample.mp4",
            "video/mp4",
            incomplete_mp4(),
        ),
        (
            MediaKind::Video,
            "invalid-avcc.mp4",
            "video/mp4",
            invalid_avcc,
        ),
        (
            MediaKind::Video,
            "invalid-offset.mp4",
            "video/mp4",
            invalid_sample_offset,
        ),
        (
            MediaKind::Video,
            "truncated.webm",
            "video/webm",
            b"\x1a\x45\xdf\xa3\x84webm".to_vec(),
        ),
        (
            MediaKind::Video,
            "wrong-track.webm",
            "video/webm",
            mismatched_webm_track,
        ),
        (MediaKind::Video, "audio.ogv", "video/ogg", audio_ogg),
        (
            MediaKind::Video,
            "bare-headers.ogv",
            "video/ogg",
            bare_theora_headers,
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        assert!(
            storage
                .store(Uuid::new_v4(), kind, name, mime, &video_policy, source,)
                .await
                .is_err(),
            "forged fixture {name} was accepted"
        );
    }
}

// Catches unchecked MP4 slicing and parser panics on arbitrary short malformed inputs.
#[tokio::test]
async fn malformed_media_never_panics_and_the_17_byte_mp4_is_rejected() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let mut cases = vec![(
        "panic.mp4",
        "video/mp4",
        [b"\0\0\0\x11ftyp".as_slice(), &[0; 9]].concat(),
    )];
    for length in 0..128_usize {
        let bytes = (0..length)
            .map(|index| (index.wrapping_mul(73) ^ length) as u8)
            .collect::<Vec<_>>();
        for (name, mime) in [
            ("fuzz.mp4", "video/mp4"),
            ("fuzz.webm", "video/webm"),
            ("fuzz.ogv", "video/ogg"),
            ("fuzz.png", "image/png"),
            ("fuzz.jpg", "image/jpeg"),
            ("fuzz.webp", "image/webp"),
        ] {
            cases.push((name, mime, bytes.clone()));
        }
    }
    let fuzz_policy = UploadPolicy::new(1024, ["video/mp4", "video/webm", "video/ogg"]).unwrap();
    for (name, mime, bytes) in cases {
        let task_storage = storage.clone();
        let task_policy = fuzz_policy.clone();
        let (source, _) = Chunks::bytes(bytes);
        let joined = tokio::spawn(async move {
            task_storage
                .store(
                    Uuid::new_v4(),
                    if mime.starts_with("image/") {
                        MediaKind::Poster
                    } else {
                        MediaKind::Video
                    },
                    name,
                    mime,
                    &task_policy,
                    source,
                )
                .await
        })
        .await;
        assert!(joined.is_ok(), "parser panicked for malformed input");
        assert!(joined.unwrap().is_err());
    }
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

    let (new_source, _) = Chunks::new([jpeg()]);
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

    let (new_source, _) = Chunks::new([jpeg()]);
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

    let (new_source, _) = Chunks::new([jpeg()]);
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

// Catches disabling Axum's body limit and accepting unbounded multipart metadata/extra fields.
#[tokio::test]
async fn multipart_request_bounds_metadata_and_requires_exactly_one_file_field() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let boundary = "bounded-boundary";

    let movie = draft_movie(&db, None).await;
    let mut oversized_preamble = vec![b'x'; 70 * 1024];
    oversized_preamble.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"movie.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").as_bytes(),
    );
    oversized_preamble.extend_from_slice(&valid_mp4());
    oversized_preamble.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            oversized_preamble,
        ))
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE
    ));

    let movie = draft_movie(&db, None).await;
    let long_name = format!("{}.mp4", "a".repeat(300));
    let mut oversized_filename = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{long_name}\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).into_bytes();
    oversized_filename.extend_from_slice(&valid_mp4());
    oversized_filename.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            oversized_filename,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let movie = draft_movie(&db, None).await;
    let mut multiple = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"movie.mp4\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).into_bytes();
    multiple.extend_from_slice(&valid_mp4());
    multiple.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\nignored\r\n--{boundary}--\r\n").as_bytes(),
    );
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            multiple,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let movie = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(movie.video_asset_id, None);
}
