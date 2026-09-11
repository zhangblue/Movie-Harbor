use super::model::AuthError;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::StatusCode;
use rand_core::OsRng;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub async fn hash(password: String) -> Result<String, AuthError> {
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

pub async fn verify(password: String, hash: String) -> Result<bool, AuthError> {
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

pub async fn hash_limited(limit: &Arc<Semaphore>, password: String) -> Result<String, AuthError> {
    let permit = limit
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    tokio::task::spawn_blocking(move || {
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

pub async fn verify_limited(
    limit: &Arc<Semaphore>,
    password: String,
    hash: String,
) -> Result<bool, AuthError> {
    let permit = limit
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AuthError(StatusCode::INTERNAL_SERVER_ERROR))?;
    tokio::task::spawn_blocking(move || {
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
