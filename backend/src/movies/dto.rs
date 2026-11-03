use crate::{
    content::Patch,
    entities::{genre, media_asset, movie},
    media::path::{controlled_media_path, controlled_media_url},
};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
/// 创建电影请求，供管理接口和 MCP 创建入口解析字段。
pub struct CreateMovieRequest {
    pub name: String,
    pub is_private: bool,
    #[serde(default)]
    pub synopsis: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub duration_seconds: Option<i32>,
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
/// 电影编辑请求，供草稿更新时解析字段补丁。
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
/// 版本请求，供状态转换和删除等并发校验使用。
pub struct VersionRequest {
    pub version: i64,
}

#[derive(Debug, Serialize)]
/// 内容删除影响响应，供管理端展示删除前统计。
pub struct DeleteImpactResponse {
    pub name: String,
    pub version: i64,
    pub season_count: u64,
    pub episode_count: u64,
    pub media_count: u64,
}

#[derive(Debug, Serialize)]
/// 内容删除结果响应，供删除成功后返回媒体清理数量。
pub struct DeleteResultResponse {
    pub deleted_media_count: u64,
}

#[derive(Debug, Default, Deserialize)]
/// 电影列表筛选参数，供列表请求解析查询条件。
pub struct MovieListQuery {
    pub status: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
/// 题材摘要，供内容响应展示关联题材。
pub struct GenreSummary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

impl From<genre::Model> for GenreSummary {
    /// 在组装内容响应时把题材模型映射为接口摘要。
    fn from(value: genre::Model) -> Self {
        Self {
            id: value.id.to_string(),
            name: value.name,
            enabled: value.enabled,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
/// 媒体摘要，供内容响应安全展示资产元数据。
pub struct MediaSummary {
    pub id: String,
    pub url: String,
    pub local_path: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
}

impl MediaSummary {
    /// 在构造内容响应时校验媒体用途并转换为安全摘要。
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
/// 电影响应，供管理端读取电影及关联信息。
pub struct MovieResponse {
    pub id: String,
    pub is_private: bool,
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
    /// 在组装接口响应时把数据库模型及关联信息转换为响应对象。
    pub fn new(
        value: movie::Model,
        genres: Vec<genre::Model>,
        poster: Option<media_asset::Model>,
        video: Option<media_asset::Model>,
    ) -> Result<Self, DbErr> {
        Ok(Self {
            id: value.id.to_string(),
            is_private: value.is_private,
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
