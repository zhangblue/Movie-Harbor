use axum::{Json, Router, routing::get};
use serde::Serialize;
use std::time::Duration;

// 健康检查响应的序列化结构，由健康检查路由返回。
#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

// 构建基础健康检查路由，供完整应用和轻量测试路由复用。
pub fn router() -> Router {
    Router::new().route("/api/health", get(health))
}

// 构建无需数据库的测试路由，供基础路由测试调用。
pub fn test_router() -> Router {
    router()
}

// 初始化共享服务并聚合全部路由；启动时在监听端口之前调用。
pub async fn build(
    db: sea_orm::DatabaseConnection,
    config: &crate::config::Config,
) -> Result<Router, Box<dyn std::error::Error>> {
    // 再次校验来源并初始化管理员；任一失败都阻止应用开始接收请求。
    let public_origin = config.validated_origin()?;
    crate::auth::initialize(&db, config).await?;
    // 各受保护路由共享同一数据库连接与认证状态，避免会话策略因路由而分裂。
    let state = crate::auth::AuthState {
        db: db.clone(),
        cookie_secure: config.cookie_secure,
        origin_policy: crate::auth::csrf::OriginPolicy::new(
            public_origin,
            config.allow_insecure_lan_http,
        ),
        trust_proxy_headers: config.trust_proxy_headers,
        trusted_proxy_secret_digest: config
            .trusted_proxy_secret
            .as_deref()
            .map(crate::auth::csrf::digest),
        mcp_api_key_digest: config.mcp_api_key_digest.clone(),
        limits: Default::default(),
        password_work: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let storage = crate::media::LocalMediaStorage::initialize(&config.media_dir).await?;
    let policy = crate::media::UploadPolicy::new(
        config.max_upload_bytes,
        config.allowed_video_mime_types.iter(),
    )?;
    // 监听前恢复中断的媒体操作；恢复失败则终止启动，避免暴露不一致状态。
    crate::media::upload::recover_stale_uploads(&db, &storage, Duration::from_secs(3600)).await?;
    crate::media::removal::recover(&db, &storage).await?;
    crate::media::staged_poster::cleanup_expired(
        &db,
        &storage,
        chrono::Utc::now().fixed_offset(),
        crate::media::staged_poster::STARTUP_CLEANUP_LIMIT,
    )
    .await?;
    // 所有媒体路由复用同一受控存储实例，确保文件恢复、上传和删除遵循同一所有权边界。
    Ok(router()
        .merge(crate::catalog::routes::router(db))
        .merge(crate::auth::routes::router(state.clone()))
        .merge(crate::viewer_auth::routes::router(state.clone()))
        .merge(crate::media::routes::authorization_router(state.clone()))
        .merge(crate::admin_content::routes::router(state.clone()))
        .merge(crate::admin_export::routes::router(state.clone()))
        .merge(crate::admin_users::routes::router(state.clone()))
        .merge(crate::genres::routes::router(state.clone()))
        .merge(crate::movies::routes::router(
            state.clone(),
            storage.clone(),
            config.allowed_video_mime_types.clone(),
        ))
        .merge(crate::series::routes::router(
            state.clone(),
            storage.clone(),
            config.allowed_video_mime_types.clone(),
        ))
        .merge(crate::media::routes::router(state, storage, policy)?))
}

// 返回进程健康状态，供健康检查路由处理请求时调用。
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
