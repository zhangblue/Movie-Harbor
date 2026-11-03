use crate::{
    content::Patch,
    entities::{episode, genre, media_asset, season, series},
    movies::dto::{GenreSummary, MediaSummary},
};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
/// 创建剧集请求，供管理接口和 MCP 创建入口解析字段。
pub struct CreateSeriesRequest {
    pub name: String,
    pub is_private: bool,
    #[serde(default)]
    pub synopsis: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub genre_ids: Option<Vec<String>>,
    #[serde(default)]
    pub staged_poster_token: Option<String>,
}

#[derive(Debug, Deserialize)]
/// 访问范围变更请求，供路由读取预期版本与隐私设置。
pub struct PrivacyRequest {
    pub version: i64,
    pub is_private: bool,
}

#[derive(Debug, Deserialize)]
/// 剧集编辑请求，供草稿更新时解析字段补丁。
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
/// 版本请求，供状态转换和删除等并发校验使用。
pub struct VersionRequest {
    pub version: i64,
}

#[derive(Debug, Serialize)]
/// 子级删除影响响应，供删除季或单集前展示统计。
pub struct ChildDeleteImpactResponse {
    pub display_name: String,
    pub version: i64,
    pub season_count: u64,
    pub episode_count: u64,
    pub media_count: u64,
}

#[derive(Debug, Deserialize)]
/// 创建季请求，供管理路由读取季序号及父版本。
pub struct CreateSeasonRequest {
    pub version: i64,
    pub number: i32,
}

#[derive(Debug, Deserialize)]
/// 修改季请求，供管理路由读取新序号及父版本。
pub struct UpdateSeasonRequest {
    pub version: i64,
    pub number: i32,
}

#[derive(Debug, Deserialize)]
/// 创建单集请求，供管理路由读取名称、序号和父版本。
pub struct CreateEpisodeRequest {
    /// 所属剧集的版本；新建时尚无单集版本。
    pub version: i64,
    pub number: i32,
    pub name: String,
    #[serde(default)]
    pub duration_seconds: Option<i32>,
}

#[derive(Debug, Deserialize)]
/// 修改单集请求，供草稿更新时解析字段补丁与版本。
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
/// 剧集列表筛选参数，供列表请求解析查询条件。
pub struct SeriesListQuery {
    pub status: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
/// 单集响应，供剧集详情和单集接口展示。
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
    /// 在组装接口响应时把数据库模型及关联信息转换为响应对象。
    pub fn new(value: episode::Model, video: Option<media_asset::Model>) -> Result<Self, DbErr> {
        Ok(Self {
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
            video: video
                .map(|asset| MediaSummary::try_from_asset(asset, "video"))
                .transpose()?,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
/// 季响应，供剧集详情按层级展示单集。
pub struct SeasonResponse {
    pub id: String,
    pub number: i32,
    pub episodes: Vec<EpisodeResponse>,
}

impl SeasonResponse {
    /// 在组装接口响应时把数据库模型及关联信息转换为响应对象。
    pub fn new(value: season::Model, episodes: Vec<EpisodeResponse>) -> Self {
        Self {
            id: value.id.to_string(),
            number: value.number,
            episodes,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
/// 剧集响应，供管理端读取剧集及关联层级。
pub struct SeriesResponse {
    pub id: String,
    pub is_private: bool,
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
    /// 在组装接口响应时把数据库模型及关联信息转换为响应对象。
    pub fn new(
        value: series::Model,
        genres: Vec<genre::Model>,
        poster: Option<media_asset::Model>,
        seasons: Vec<SeasonResponse>,
    ) -> Result<Self, DbErr> {
        Ok(Self {
            id: value.id.to_string(),
            is_private: value.is_private,
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
            poster: poster
                .map(|asset| MediaSummary::try_from_asset(asset, "poster"))
                .transpose()?,
            seasons,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
/// 单集响应及父版本封装，供单集写入后更新客户端状态。
pub struct EpisodeEnvelope {
    pub series_version: i64,
    pub episode: EpisodeResponse,
}
