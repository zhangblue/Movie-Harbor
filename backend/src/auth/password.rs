use super::model::AuthError;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::StatusCode;
use rand_core::OsRng;

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
