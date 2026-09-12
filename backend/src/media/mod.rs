pub mod removal;
pub mod routes;
pub mod storage;
pub mod upload;
pub mod validation;

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::{fmt, io};

pub use storage::{ChunkSource, LocalMediaStorage, StorageEvent, StorageHooks, StoredFile};
pub use upload::{AttachmentTarget, replace_attachment, store_new_asset};
pub use validation::{MediaKind, UploadPolicy};

/// Validate a registered asset at the publication boundary without opening special files.
pub fn is_publishable_asset<S: AsRef<str>>(
    storage: &LocalMediaStorage,
    asset: Option<&crate::entities::media_asset::Model>,
    purpose: &str,
    allowed_mime_types: &[S],
) -> bool {
    let Some(asset) = asset else {
        return false;
    };
    asset.purpose == purpose
        && allowed_mime_types
            .iter()
            .any(|mime| mime.as_ref() == asset.mime_type)
        && storage
            .is_accessible_regular_file(&asset.storage_key)
            .unwrap_or(false)
}

#[derive(Debug)]
pub enum MediaError {
    InvalidFileName,
    InvalidStorageKey,
    UnsupportedType,
    ContentMismatch,
    TooLarge,
    Empty,
    TargetNotFound,
    ReadOnly,
    InvalidVersion,
    VersionConflict,
    StillReferenced,
    ReplacementFailed,
    Io(io::Error),
    Database(sea_orm::DbErr),
    Multipart(String),
}

impl fmt::Display for MediaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidFileName => "invalid upload filename",
            Self::InvalidStorageKey => "invalid media storage key",
            Self::UnsupportedType => "unsupported media type",
            Self::ContentMismatch => "media content does not match its declared type",
            Self::TooLarge => "upload exceeds configured byte limit",
            Self::Empty => "upload is empty",
            Self::TargetNotFound => "media attachment target not found",
            Self::ReadOnly => "only draft content can replace media",
            Self::InvalidVersion => "invalid content version",
            Self::VersionConflict => "content version conflict",
            Self::StillReferenced => "media asset is still referenced",
            Self::ReplacementFailed => "media replacement failed",
            Self::Io(_) => "media filesystem operation failed",
            Self::Database(_) => "media database operation failed",
            Self::Multipart(_) => "invalid multipart upload",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for MediaError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Database(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for MediaError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<sea_orm::DbErr> for MediaError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Database(error)
    }
}

impl IntoResponse for MediaError {
    fn into_response(self) -> Response {
        if matches!(self, Self::ReplacementFailed) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "media replacement failed",
                    "code": "media_replace_failed"
                })),
            )
                .into_response();
        }
        let status = match self {
            Self::InvalidFileName | Self::InvalidVersion | Self::Empty | Self::Multipart(_) => {
                StatusCode::BAD_REQUEST
            }
            Self::UnsupportedType | Self::ContentMismatch => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::TargetNotFound => StatusCode::NOT_FOUND,
            Self::ReadOnly | Self::VersionConflict | Self::StillReferenced => StatusCode::CONFLICT,
            Self::InvalidStorageKey | Self::ReplacementFailed | Self::Io(_) | Self::Database(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, Json(serde_json::json!({"error": self.to_string()}))).into_response()
    }
}
