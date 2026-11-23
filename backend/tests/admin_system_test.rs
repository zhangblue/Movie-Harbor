mod support;

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    admin_system,
    auth::{self, AuthState},
    config::Config,
    media::{LocalMediaStorage, StorageCapacity, StorageCapacityReader, StorageHooks},
};
use rustix::fd::BorrowedFd;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use support::TestDatabase;
use tower::ServiceExt;
use uuid::Uuid;

/// 为系统概览测试持有权限受控的临时媒体目录。
struct TempRoot(PathBuf);

impl TempRoot {
    /// 为单个测试创建唯一目录，避免容量和文件状态互相干扰。
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("movie_harbor_admin_system_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl AsRef<Path> for TempRoot {
    /// 在存储初始化时借用临时目录路径。
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    /// 测试结束后仅清理本测试创建的目录。
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 在概览测试中返回确定容量或模拟文件系统统计失败。
struct CapacityReader {
    capacity: StorageCapacity,
    fail: bool,
}

impl StorageCapacityReader for CapacityReader {
    /// 返回预设结果，使卷状态测试不依赖开发机真实磁盘容量。
    fn read(&self, _root: BorrowedFd<'_>) -> std::io::Result<StorageCapacity> {
        if self.fail {
            Err(std::io::Error::other("hidden capacity error"))
        } else {
            Ok(self.capacity)
        }
    }
}

/// 为管理员认证和系统概览路由构造最小有效配置。
fn config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: root.into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        mcp_api_key_digest: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

/// 组装共享认证状态，使被测路由使用真实管理员会话中间件。
fn auth_state(db: sea_orm::DatabaseConnection, config: &Config) -> AuthState {
    AuthState {
        db,
        cookie_secure: config.cookie_secure,
        origin_policy: auth::csrf::OriginPolicy::new(config.validated_origin().unwrap(), false),
        trust_proxy_headers: false,
        trusted_proxy_secret_digest: None,
        mcp_api_key_digest: None,
        limits: Default::default(),
        password_work: Arc::new(tokio::sync::Semaphore::new(2)),
    }
}

/// 构造带可注入容量采样的完整认证与系统概览路由。
async fn test_app(db: &TestDatabase, root: &TempRoot, reader: CapacityReader) -> Router {
    let configuration = config(root.as_ref());
    auth::initialize(db, &configuration).await.unwrap();
    let state = auth_state(db.connection(), &configuration);
    let storage = LocalMediaStorage::initialize_with_hooks_and_capacity_reader(
        root.as_ref(),
        Arc::new(TestHooks),
        Arc::new(reader),
    )
    .await
    .unwrap();
    auth::routes::router(state.clone()).merge(admin_system::routes::router(state, storage))
}

/// 系统概览测试不需要观察存储事件，保持钩子无副作用。
struct TestHooks;
impl StorageHooks for TestHooks {}

/// 发送带真实连接地址的请求，复用生产 Host 校验。
async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Body,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "harbor.test");
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    if method != "GET" {
        builder = builder
            .header("origin", "https://harbor.test")
            .header("content-type", "application/json");
    }
    let mut request = builder.body(body).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

/// 登录预置管理员并返回后续只读请求使用的 Cookie。
async fn login(app: &Router) -> String {
    let response = request(
        app,
        "POST",
        "/api/admin/login",
        None,
        Body::from(json!({"name":"Admin","password":"initial-password"}).to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

/// 读取 JSON 响应，供字段和敏感信息断言使用。
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// 写入覆盖生命周期、用户会话和两类媒体的概览样本。
async fn seed(db: &TestDatabase) {
    db.execute_unprepared(r#"
INSERT INTO movie (id, name, status, version) VALUES
('10000000-0000-0000-0000-000000000001', 'Draft movie', 'draft', 1),
('10000000-0000-0000-0000-000000000002', 'Published movie', 'published', 1),
('10000000-0000-0000-0000-000000000003', 'Archived movie', 'archived', 1);
INSERT INTO series (id, name, status, version) VALUES
('20000000-0000-0000-0000-000000000001', 'Published series', 'published', 1);
INSERT INTO season (id, series_id, number) VALUES ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1);
INSERT INTO episode (id, season_id, number, name, status, version) VALUES
('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'Draft episode', 'draft', 1),
('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 2, 'Published episode', 'published', 1);
INSERT INTO viewer_user (id, username, normalized_username, password_hash, version) VALUES
('50000000-0000-0000-0000-000000000001', 'Viewer 1', 'viewer 1', 'hash', 1),
('50000000-0000-0000-0000-000000000002', 'Viewer 2', 'viewer 2', 'hash', 1);
INSERT INTO viewer_session (id, viewer_user_id, token_hash, csrf_token_hash, expires_at) VALUES
('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'token-1', 'csrf-1', now() + interval '1 day'),
('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'token-2', 'csrf-2', now() - interval '1 day');
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
('70000000-0000-0000-0000-000000000001', 'poster/aa/70000000-0000-0000-0000-000000000001.webp', 'p.webp', 'image/webp', 100, 'poster'),
('70000000-0000-0000-0000-000000000002', 'video/aa/70000000-0000-0000-0000-000000000002.mp4', 'v.mp4', 'video/mp4', 900, 'video');
"#).await.unwrap();
}

#[tokio::test]
/// 验证概览要求管理员身份并返回一致摘要、低空间状态和禁止缓存策略。
async fn admin_system_overview_is_authenticated_and_reports_low_capacity() {
    let db = TestDatabase::migrated("admin_system_low").await;
    seed(&db).await;
    let root = TempRoot::new();
    let reserve = 10 * 1024 * 1024 * 1024;
    let app = test_app(
        &db,
        &root,
        CapacityReader {
            capacity: StorageCapacity {
                total_bytes: reserve * 4,
                available_bytes: reserve,
            },
            fail: false,
        },
    )
    .await;
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/system/overview",
            None,
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let cookie = login(&app).await;
    let response = request(
        &app,
        "GET",
        "/api/admin/system/overview",
        Some(&cookie),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cache = response.headers()["cache-control"].to_str().unwrap();
    assert!(cache.contains("private") && cache.contains("no-store"));
    let value = body(response).await;
    assert_eq!(value["status"], "attention");
    assert_eq!(
        value["counts"]["movies"],
        json!({"draft":1,"published":1,"archived":1})
    );
    assert_eq!(
        value["counts"]["series"],
        json!({"draft":0,"published":1,"archived":0})
    );
    assert_eq!(
        value["counts"]["episodes"],
        json!({"draft":1,"published":1,"archived":0})
    );
    assert_eq!(value["counts"]["viewer_users"], 2);
    assert_eq!(value["counts"]["active_viewer_users"], 1);
    assert_eq!(value["counts"]["posters"], json!({"count":1,"bytes":100}));
    assert_eq!(value["counts"]["videos"], json!({"count":1,"bytes":900}));
    assert_eq!(value["volumes"][0]["status"], "space_low");
    assert_eq!(value["volumes"][0]["writable_bytes"], 0);
    assert_eq!(value["volumes"][0]["accepts_uploads"], false);
    assert_eq!(value["backup"]["status"], "unverifiable");
    assert_eq!(value["warnings"][0]["code"], "storage_space_low");
    let encoded = value.to_string();
    assert!(!encoded.contains(root.as_ref().to_str().unwrap()));
    assert!(!encoded.contains("storage_key") && !encoded.contains("hidden capacity error"));
}

#[tokio::test]
/// 验证容量失败保留数据库摘要并以 null 和受控告警表达未知事实。
async fn admin_system_overview_degrades_when_capacity_is_unavailable() {
    let db = TestDatabase::migrated("admin_system_unknown").await;
    seed(&db).await;
    let root = TempRoot::new();
    let app = test_app(
        &db,
        &root,
        CapacityReader {
            capacity: StorageCapacity {
                total_bytes: 1,
                available_bytes: 1,
            },
            fail: true,
        },
    )
    .await;
    let cookie = login(&app).await;
    let response = request(
        &app,
        "GET",
        "/api/admin/system/overview",
        Some(&cookie),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let value = body(response).await;
    assert_eq!(value["volumes"][0]["status"], "unavailable");
    assert_eq!(value["volumes"][0]["total_bytes"], Value::Null);
    assert_eq!(value["volumes"][0]["available_bytes"], Value::Null);
    assert_eq!(value["volumes"][0]["writable_bytes"], Value::Null);
    assert_eq!(value["volumes"][0]["asset_count"], 2);
    assert_eq!(
        value["warnings"],
        json!([{"code":"storage_capacity_unavailable","scope":"volume:0","message":"无法读取媒体卷容量"}])
    );
}

#[tokio::test]
/// 验证数据库摘要失败不会伪造零值，而是统一返回服务器错误。
async fn admin_system_overview_fails_when_database_summary_is_unavailable() {
    let db = TestDatabase::migrated("admin_system_database").await;
    let root = TempRoot::new();
    let app = test_app(
        &db,
        &root,
        CapacityReader {
            capacity: StorageCapacity {
                total_bytes: 20,
                available_bytes: 20,
            },
            fail: false,
        },
    )
    .await;
    let cookie = login(&app).await;
    db.execute_unprepared("DROP TABLE movie CASCADE")
        .await
        .unwrap();
    let response = request(
        &app,
        "GET",
        "/api/admin/system/overview",
        Some(&cookie),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body(response).await,
        json!({"error":"internal server error"})
    );
}
