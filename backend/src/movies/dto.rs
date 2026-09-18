use crate::{
    content::Patch,
    entities::{genre, media_asset, movie},
    media::path::{controlled_media_path, controlled_media_url},
};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateMovieRequest {
    pub name: String,
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
    pub local_path: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
}

impl MediaSummary {
    pub fn try_from_asset(value: media_asset::Model, expected_kind: &str) -> Result<Self, DbErr> {
        // 管理响应的 URL 和容器内路径均由用途匹配的受控存储键派生；异常记录直接报错，不能输出任意路径。
        if value.purpose != expected_kind {
            return Err(DbErr::Custom("invalid media asset purpose".into()));
        }
        let url = controlled_media_url(&value.storage_key, expected_kind)
            .ok_or_else(|| DbErr::Custom("invalid media asset storage key".into()))?;
        let local_path = controlled_media_path(&value.storage_key, expected_kind)
            .ok_or_else(|| DbErr::Custom("invalid media asset storage key".into()))?;
        Ok(Self {
            id: value.id.to_string(),
            url,
            local_path,
            original_name: value.original_name,
            mime_type: value.mime_type,
            byte_size: value.byte_size,
        })
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
    ) -> Result<Self, DbErr> {
        Ok(Self {
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
            poster: poster
                .map(|asset| MediaSummary::try_from_asset(asset, "poster"))
                .transpose()?,
            video: video
                .map(|asset| MediaSummary::try_from_asset(asset, "video"))
                .transpose()?,
        })
    }
}
