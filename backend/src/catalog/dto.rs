use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::media::path::controlled_media_url;

pub const DEFAULT_PAGE_SIZE: u64 = 20;
pub const MAX_PAGE_SIZE: u64 = 100;

#[derive(Debug, Default, Deserialize)]
// 承载公开目录筛选和分页参数，供目录路由解析请求。
pub struct CatalogRequest {
    pub kind: Option<String>,
    /// 去除首尾空白后的子串搜索。大小写折叠遵循数据库排序规则下 PostgreSQL 的 `lower`；
    /// LIKE 元字符会被转义，因此所有用户输入都按普通文本匹配。
    pub q: Option<String>,
    pub privacy: Option<String>,
    pub page: Option<u64>,
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
// 表示目录内容类型筛选，供目录查询使用。
pub enum CatalogKind {
    All,
    Movie,
    Series,
}

impl CatalogKind {
    // 转换类型筛选为数据库查询值，供目录查询构造参数时调用。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

#[derive(Debug)]
// 保存已校验的目录筛选与分页条件，供目录查询使用。
pub struct CatalogFilter {
    pub kind: CatalogKind,
    pub search_pattern: Option<String>,
    pub private_only: bool,
    pub page: u64,
    pub size: u64,
    pub offset: u64,
    pub window: u64,
}

impl TryFrom<CatalogRequest> for CatalogFilter {
    // 指定目录参数转换的无详情错误，供路由映射为无效请求。
    type Error = ();

    // 校验目录参数并计算分页窗口，供公开列表查询前调用。
    fn try_from(value: CatalogRequest) -> Result<Self, Self::Error> {
        let kind = match value.kind.as_deref().unwrap_or("all") {
            "all" => CatalogKind::All,
            "movie" => CatalogKind::Movie,
            "series" => CatalogKind::Series,
            _ => return Err(()),
        };
        let page = value.page.unwrap_or(1);
        let size = value.size.unwrap_or(DEFAULT_PAGE_SIZE);
        if page == 0 || size == 0 || size > MAX_PAGE_SIZE {
            return Err(());
        }
        let offset = page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(size))
            .ok_or(())?;
        i64::try_from(offset).map_err(|_| ())?;
        let window = offset.checked_add(size).ok_or(())?;
        i64::try_from(window).map_err(|_| ())?;
        let search_pattern = value
            .q
            .map(|query| query.trim().to_owned())
            .filter(|query| !query.is_empty())
            .map(|query| format!("%{}%", escape_like(&query)));
        let private_only = value.privacy.as_deref() == Some("private");
        Ok(Self {
            kind,
            search_pattern,
            private_only,
            page,
            size,
            offset,
            window,
        })
    }
}

// 转义搜索内容中的 LIKE 元字符，供目录筛选构造时调用。
fn escape_like(value: &str) -> String {
    // 对 `%`、`_` 和转义符本身进行转义，使访客输入始终按普通文本匹配。
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '!' | '%' | '_') {
            escaped.push('!');
        }
        escaped.push(character);
    }
    escaped
}

#[derive(Clone, Debug, Serialize)]
// 承载公开题材标识和名称，供目录与详情响应使用。
pub struct PublicGenre {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
// 承载公开目录卡片数据，供分页列表响应使用。
pub struct CatalogCard {
    pub id: String,
    pub is_private: bool,
    pub kind: String,
    pub name: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub published_at: String,
    pub genres: Vec<PublicGenre>,
    pub genre_count: usize,
}

#[derive(Debug, Serialize)]
// 承载公开目录分页结果，供目录列表路由返回。
pub struct CatalogPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<CatalogCard>,
}

#[derive(Debug, Serialize)]
// 承载公开电影详情，供电影详情路由返回。
pub struct MovieDetail {
    pub id: String,
    pub is_private: bool,
    pub kind: &'static str,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub duration_seconds: Option<i32>,
    pub poster_url: Option<String>,
    pub video_url: Option<String>,
    pub genres: Vec<PublicGenre>,
}

#[derive(Debug, Serialize)]
// 承载公开剧集及季信息，供剧集详情路由返回。
pub struct SeriesDetail {
    pub id: String,
    pub is_private: bool,
    pub kind: &'static str,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub genres: Vec<PublicGenre>,
    pub seasons: Vec<PublicSeason>,
}

#[derive(Debug, Serialize)]
// 承载公开季及其单集，供剧集详情响应使用。
pub struct PublicSeason {
    pub id: String,
    pub number: i32,
    pub episodes: Vec<PublicEpisode>,
}

#[derive(Debug, Serialize)]
// 承载公开单集数据，供剧集详情响应使用。
pub struct PublicEpisode {
    pub id: String,
    pub number: i32,
    pub name: String,
    pub duration_seconds: Option<i32>,
    pub video_url: Option<String>,
}

// 从受控存储键生成媒体 URL，供目录和详情响应组装时调用。
pub(crate) fn media_url(storage_key: Option<String>, expected_kind: &str) -> Option<String> {
    storage_key.and_then(|key| controlled_media_url(&key, expected_kind))
}

// 格式化发布时间，供目录卡片响应组装时调用。
pub(crate) fn published_at_string(value: DateTime<FixedOffset>) -> String {
    value.to_rfc3339()
}

// 构建公开题材对象，供目录和详情查询结果转换时调用。
pub(crate) fn public_genre(id: Uuid, name: String) -> PublicGenre {
    PublicGenre {
        id: id.to_string(),
        name,
    }
}
