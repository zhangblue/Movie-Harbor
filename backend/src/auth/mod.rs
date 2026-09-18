pub mod csrf;
pub mod model;
pub mod password;
pub mod rate_limit;
pub mod routes;
pub mod session;

use crate::{
    config::{Config, ConfigError},
    entities::admin_user,
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, EntityTrait, Set, TransactionTrait,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct AuthState {
    pub db: DatabaseConnection,
    pub cookie_secure: bool,
    pub public_origin: url::Url,
    pub trust_proxy_headers: bool,
    pub trusted_proxy_secret_digest: Option<String>,
    pub limits: Arc<rate_limit::RateLimiter>,
    pub password_work: Arc<tokio::sync::Semaphore>,
}

pub async fn initialize(
    db: &DatabaseConnection,
    config: &Config,
) -> Result<(), Box<dyn std::error::Error>> {
    // 管理员初始化必须在同一事务内完成，避免并发启动分别观察到空表后各自创建账号。
    let tx = db.begin().await?;
    // 在查询唯一管理员前锁定整张表，使并发启动只能按顺序判断是否需要初始化。
    tx.execute_unprepared("LOCK TABLE admin_user IN EXCLUSIVE MODE")
        .await?;
    // 已有管理员时完全忽略环境变量中的初始凭据，避免重启服务意外重置既有账号。
    if admin_user::Entity::find().one(&tx).await?.is_none() {
        let required = |value: &Option<String>, name| {
            value
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .ok_or(ConfigError::Missing(name))
        };
        let name = required(&config.admin_name, "ADMIN_NAME")?;
        let password = required(&config.admin_initial_password, "ADMIN_INITIAL_PASSWORD")?;
        // 首次初始化也使用与登录一致的密码哈希，而不是将明文或可逆值写入数据库。
        let password_hash = password::hash(password)
            .await
            .map_err(|_| std::io::Error::other("password hashing failed"))?;
        admin_user::ActiveModel {
            id: Set(uuid::Uuid::new_v4()),
            name: Set(name),
            password_hash: Set(password_hash),
            ..Default::default()
        }
        .insert(&tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
