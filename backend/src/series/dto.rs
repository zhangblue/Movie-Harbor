use crate::{
    entities::{episode, genre, media_asset, season, series},
    movies::dto::{GenreSummary, MediaSummary, Patch},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateSeriesRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSeriesRequest {
    pub version: i64,
    #[serde(default)]
    pub name: Patch<String>,
    #[serde(default)]
    pub synopsis: Patch<String>,
    #[serde(default)]
    pub year: Patch<i32>,
    pub genre_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct VersionRequest {
    pub version: i64,
}

#[derive(Debug, Serialize)]
pub struct ChildDeleteImpactResponse {
    pub display_name: String,
    pub version: i64,
    pub season_count: u64,
    pub episode_count: u64,
    pub media_count: u64,
}

#[derive(Debug, Deserialize)]
pub struct CreateSeasonRequest {
    pub version: i64,
    pub number: i32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSeasonRequest {
    pub version: i64,
    pub number: i32,
}

#[derive(Debug, Deserialize)]
pub struct CreateEpisodeRequest {
    /// The containing series version; creation has no episode version yet.
    pub version: i64,
    pub number: i32,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEpisodeRequest {
    pub version: i64,
    #[serde(default)]
    pub number: Patch<i32>,
    #[serde(default)]
    pub name: Patch<String>,
    #[serde(default)]
    pub duration_seconds: Patch<i32>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SeriesListQuery {
    pub status: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EpisodeResponse {
    pub id: String,
    pub season_id: String,
    pub number: i32,
    pub name: String,
    pub duration_seconds: Option<i32>,
    pub status: String,
    pub version: i64,
    pub published_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub video: Option<MediaSummary>,
}

impl EpisodeResponse {
    pub fn new(value: episode::Model, video: Option<media_asset::Model>) -> Self {
        Self {
            id: value.id.to_string(),
            season_id: value.season_id.to_string(),
            number: value.number,
            name: value.name,
            duration_seconds: value.duration_seconds,
            status: value.status,
            version: value.version,
            published_at: value.published_at.map(|value| value.to_rfc3339()),
            archived_at: value.archived_at.map(|value| value.to_rfc3339()),
            created_at: value.created_at.to_rfc3339(),
            updated_at: value.updated_at.to_rfc3339(),
            video: video.map(Into::into),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SeasonResponse {
    pub id: String,
    pub number: i32,
    pub episodes: Vec<EpisodeResponse>,
}

impl SeasonResponse {
    pub fn new(value: season::Model, episodes: Vec<EpisodeResponse>) -> Self {
        Self {
            id: value.id.to_string(),
            number: value.number,
            episodes,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SeriesResponse {
    pub id: String,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub status: String,
    pub version: i64,
    pub published_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub genres: Vec<GenreSummary>,
    pub poster: Option<MediaSummary>,
    pub seasons: Vec<SeasonResponse>,
}

impl SeriesResponse {
    pub fn new(
        value: series::Model,
        genres: Vec<genre::Model>,
        poster: Option<media_asset::Model>,
        seasons: Vec<SeasonResponse>,
    ) -> Self {
        Self {
            id: value.id.to_string(),
            name: value.name,
            synopsis: value.synopsis,
            year: value.year,
            status: value.status,
            version: value.version,
            published_at: value.published_at.map(|value| value.to_rfc3339()),
            archived_at: value.archived_at.map(|value| value.to_rfc3339()),
            created_at: value.created_at.to_rfc3339(),
            updated_at: value.updated_at.to_rfc3339(),
            genres: genres.into_iter().map(Into::into).collect(),
            poster: poster.map(Into::into),
            seasons,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EpisodeEnvelope {
    pub series_version: i64,
    pub episode: EpisodeResponse,
}
