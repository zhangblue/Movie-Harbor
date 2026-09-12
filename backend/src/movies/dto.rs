use crate::entities::{genre, media_asset, movie};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateMovieRequest {
    pub name: String,
}

#[derive(Debug, Default)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T> Deserialize<'de> for Patch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateMovieRequest {
    pub version: i64,
    #[serde(default)]
    pub name: Patch<String>,
    #[serde(default)]
    pub synopsis: Patch<String>,
    #[serde(default)]
    pub year: Patch<i32>,
    #[serde(default)]
    pub duration_seconds: Patch<i32>,
    pub genre_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct VersionRequest {
    pub version: i64,
}

#[derive(Debug, Serialize)]
pub struct DeleteImpactResponse {
    pub name: String,
    pub version: i64,
    pub season_count: u64,
    pub episode_count: u64,
    pub media_count: u64,
}

#[derive(Debug, Serialize)]
pub struct DeleteResultResponse {
    pub deleted_media_count: u64,
}

#[derive(Debug, Deserialize)]
pub struct AssociateMediaRequest {
    pub version: i64,
    pub asset_id: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct MovieListQuery {
    pub status: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GenreSummary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

impl From<genre::Model> for GenreSummary {
    fn from(value: genre::Model) -> Self {
        Self {
            id: value.id.to_string(),
            name: value.name,
            enabled: value.enabled,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MediaSummary {
    pub id: String,
    pub url: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
}

impl From<media_asset::Model> for MediaSummary {
    fn from(value: media_asset::Model) -> Self {
        Self {
            id: value.id.to_string(),
            url: format!("/media/{}", value.storage_key),
            original_name: value.original_name,
            mime_type: value.mime_type,
            byte_size: value.byte_size,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MovieResponse {
    pub id: String,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub duration_seconds: Option<i32>,
    pub status: String,
    pub version: i64,
    pub published_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub genres: Vec<GenreSummary>,
    pub poster: Option<MediaSummary>,
    pub video: Option<MediaSummary>,
}

impl MovieResponse {
    pub fn new(
        value: movie::Model,
        genres: Vec<genre::Model>,
        poster: Option<media_asset::Model>,
        video: Option<media_asset::Model>,
    ) -> Self {
        Self {
            id: value.id.to_string(),
            name: value.name,
            synopsis: value.synopsis,
            year: value.year,
            duration_seconds: value.duration_seconds,
            status: value.status,
            version: value.version,
            published_at: value.published_at.map(|value| value.to_rfc3339()),
            archived_at: value.archived_at.map(|value| value.to_rfc3339()),
            created_at: value.created_at.to_rfc3339(),
            updated_at: value.updated_at.to_rfc3339(),
            genres: genres.into_iter().map(Into::into).collect(),
            poster: poster.map(Into::into),
            video: video.map(Into::into),
        }
    }
}
