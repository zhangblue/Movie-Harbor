use super::model::AuthError;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::StatusCode;
use rand_core::OsRng;
use std::sync::Arc;
use tokio::sync::Semaphore;

// 在阻塞线程生成密码哈希，供管理员初始化调用。
pub async fn hash(password: String) -> Result<String, AuthError> {
    // Argon2 是 CPU 密集型计算，移入阻塞线程池以免占用 Tokio 的异步工作线程。
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))
    })
    .await
    .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?
}

// 在阻塞线程校验密码哈希，供需要验证凭据的流程调用。
pub async fn verify(password: String, hash: String) -> Result<bool, AuthError> {
    // 校验同样可能耗尽 CPU，不能直接在异步执行器上运行。
    tokio::task::spawn_blocking(move || {
        let parsed =
            PasswordHash::new(&hash).map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?
}

// 在并发限制下生成密码哈希，供账号创建或改密调用。
pub async fn hash_limited(limit: &Arc<Semaphore>, password: String) -> Result<String, AuthError> {
    // 信号量限制同时进行的 Argon2 数量，避免密码修改高峰把所有 CPU 时间耗尽。
    let permit = limit
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    tokio::task::spawn_blocking(move || {
        // 许可随阻塞任务存活，完整覆盖哈希生命周期，从而限制同时执行的 Argon2 数量。
        let _permit = permit;
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))
    })
    .await
    .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?
}

// 在并发限制下校验密码哈希，供登录和改密流程调用。
pub async fn verify_limited(
    limit: &Arc<Semaphore>,
    password: String,
    hash: String,
) -> Result<bool, AuthError> {
    // 登录校验与改密校验共用同一预算，避免其中一路绕开 CPU 并发保护。
    let permit = limit
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    tokio::task::spawn_blocking(move || {
        // 将许可移动进阻塞闭包，任务结束前都不会提前释放并发槽位。
        let _permit = permit;
        let parsed =
            PasswordHash::new(&hash).map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?
}
