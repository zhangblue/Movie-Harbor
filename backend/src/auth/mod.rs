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
    pub limits: Arc<rate_limit::RateLimiter>,
}

pub async fn initialize(
    db: &DatabaseConnection,
    config: &Config,
) -> Result<(), Box<dyn std::error::Error>> {
    let tx = db.begin().await?;
    // Serialize concurrent bootstraps before checking for the only administrator.
    tx.execute_unprepared("LOCK TABLE admin_user IN EXCLUSIVE MODE")
        .await?;
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
