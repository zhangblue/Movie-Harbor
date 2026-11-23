use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

pub const ADMIN_CONTENT_PAGE_SIZE: u64 = 20;
pub const MAX_ADMIN_CONTENT_PAGE: u64 = 1_000_000;
pub const MAX_BULK_TARGETS: usize = 20;
pub const MAX_BULK_GENRES: usize = 20;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
// 表示批量操作支持的内容形态，供目标校验、锁定排序和响应使用。
pub enum BulkContentKind {
    Movie,
    Series,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
// 表示一个带乐观锁版本的批量目标，供事务校验当前内容。
pub struct BulkTarget {
    pub kind: BulkContentKind,
    pub id: Uuid,
    pub version: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
// 表示题材关联调整方向，供服务区分添加与移除规则。
pub enum BulkGenreMode {
    Add,
    Remove,
}

#[derive(Clone, Debug)]
// 表示经过结构、数量和唯一性校验的一次批量动作。
pub enum BulkActionRequest {
    SetPrivacy {
        is_private: bool,
        targets: Vec<BulkTarget>,
    },
    UpdateGenres {
        mode: BulkGenreMode,
        genre_ids: Vec<Uuid>,
        targets: Vec<BulkTarget>,
    },
    Archive {
        targets: Vec<BulkTarget>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
// 承载尚未完成集合校验的批量请求，供 JSON 判别字段解析使用。
enum BulkActionWire {
    SetPrivacy {
        is_private: bool,
        targets: Vec<BulkTarget>,
    },
    UpdateGenres {
        mode: BulkGenreMode,
        genre_ids: Vec<Uuid>,
        targets: Vec<BulkTarget>,
    },
    Archive {
        targets: Vec<BulkTarget>,
    },
}

#[derive(Clone, Copy, Debug)]
/// 表示批量请求结构或集合约束无效，供路由统一映射为 400 而不泄漏解析细节。
pub struct BulkRequestParseError;

impl BulkActionRequest {
    // 从任意 JSON 值解析并完成批量数量、正版本及唯一性校验，供路由返回统一 400。
    pub fn from_value(value: Value) -> Result<Self, BulkRequestParseError> {
        let wire: BulkActionWire =
            serde_json::from_value(value).map_err(|_| BulkRequestParseError)?;
        let request = match wire {
            BulkActionWire::SetPrivacy {
                is_private,
                targets,
            } => Self::SetPrivacy {
                is_private,
                targets,
            },
            BulkActionWire::UpdateGenres {
                mode,
                genre_ids,
                targets,
            } => {
                validate_genres(&genre_ids)?;
                Self::UpdateGenres {
                    mode,
                    genre_ids,
                    targets,
                }
            }
            BulkActionWire::Archive { targets } => Self::Archive { targets },
        };
        validate_targets(request.targets())?;
        Ok(request)
    }

    // 返回当前动作目标切片，供路由、服务和公共校验共享同一目标集合。
    pub fn targets(&self) -> &[BulkTarget] {
        match self {
            Self::SetPrivacy { targets, .. }
            | Self::UpdateGenres { targets, .. }
            | Self::Archive { targets } => targets,
        }
    }
}

// 校验一至二十个正版本且 kind+id 唯一的目标，供所有动作解析时调用。
fn validate_targets(targets: &[BulkTarget]) -> Result<(), BulkRequestParseError> {
    if targets.is_empty() || targets.len() > MAX_BULK_TARGETS {
        return Err(BulkRequestParseError);
    }
    let mut unique = HashSet::with_capacity(targets.len());
    if targets
        .iter()
        .any(|target| target.version <= 0 || !unique.insert((target.kind, target.id)))
    {
        return Err(BulkRequestParseError);
    }
    Ok(())
}

// 校验一至二十个唯一题材标识，供题材动作进入事务前调用。
fn validate_genres(genre_ids: &[Uuid]) -> Result<(), BulkRequestParseError> {
    if genre_ids.is_empty() || genre_ids.len() > MAX_BULK_GENRES {
        return Err(BulkRequestParseError);
    }
    let unique = genre_ids.iter().copied().collect::<HashSet<_>>();
    if unique.len() != genre_ids.len() {
        return Err(BulkRequestParseError);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
// 表示批量目标失败原因，供 409 响应提供稳定机器码。
pub enum BulkTargetProblemReason {
    NotFound,
    VersionConflict,
    InvalidState,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
// 表示批量题材失败原因，供 409 响应区分不存在与停用。
pub enum BulkGenreProblemReason {
    NotFound,
    Inactive,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
// 表示批量事务发现的一个领域问题，供路由一次返回完整集合。
pub enum BulkProblem {
    Target {
        kind: BulkContentKind,
        id: Uuid,
        reason: BulkTargetProblemReason,
    },
    Genre {
        genre_id: Uuid,
        reason: BulkGenreProblemReason,
    },
}

#[derive(Clone, Debug, Serialize)]
// 表示成功响应中的题材摘要，供管理界面核对最终关联。
pub struct BulkGenreSummary {
    pub id: Uuid,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
// 表示一个批量目标提交后的新版本与内容摘要。
pub struct BulkActionResult {
    pub kind: BulkContentKind,
    pub id: Uuid,
    pub version: i64,
    pub status: String,
    pub is_private: bool,
    pub genres: Vec<BulkGenreSummary>,
}

#[derive(Clone, Debug, Serialize)]
// 表示原子批量操作全部成功后的响应。
pub struct BulkActionResponse {
    pub results: Vec<BulkActionResult>,
}

#[derive(Debug, Default, Deserialize)]
// 承载管理内容列表查询参数，供路由解析请求。
pub struct AdminContentRequest {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub privacy: Option<String>,
    pub name: Option<String>,
    pub page: Option<u64>,
}

// 保存已校验的内容筛选和分页条件，供管理列表查询使用。
pub struct AdminContentFilter {
    pub kind: String,
    pub status: Option<String>,
    pub is_private: Option<bool>,
    pub name_pattern: Option<String>,
    pub page: u64,
    pub offset: u64,
}

impl TryFrom<AdminContentRequest> for AdminContentFilter {
    // 指定列表参数转换的无详情错误，供路由映射为无效请求。
    type Error = ();

    // 校验列表参数并计算分页偏移，供管理列表查询前调用。
    fn try_from(value: AdminContentRequest) -> Result<Self, Self::Error> {
        let kind = match value.kind.as_deref().unwrap_or("all") {
            "all" => "all",
            "movie" => "movie",
            "series" => "series",
            _ => return Err(()),
        }
        .to_owned();
        let status = match value.status {
            Some(status) if matches!(status.as_str(), "draft" | "published" | "archived") => {
                Some(status)
            }
            Some(_) => return Err(()),
            None => None,
        };
        let is_private = match value.privacy.as_deref() {
            Some("public") => Some(false),
            Some("private") => Some(true),
            None => None,
            Some(_) => return Err(()),
        };
        let name_pattern = value
            .name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .map(|name| format!("%{}%", escape_like(&name)));
        let page = value.page.unwrap_or(1);
        if page == 0 || page > MAX_ADMIN_CONTENT_PAGE {
            return Err(());
        }
        let offset = page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(ADMIN_CONTENT_PAGE_SIZE))
            .ok_or(())?;
        Ok(Self {
            kind,
            status,
            is_private,
            name_pattern,
            page,
            offset,
        })
    }
}

// 转义名称筛选中的 LIKE 元字符，供构造字面匹配条件时调用。
fn escape_like(value: &str) -> String {
    // 转义 LIKE 通配符及转义符本身，使名称筛选按管理员输入的字面内容匹配。
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '!' | '%' | '_') {
            escaped.push('!');
        }
        escaped.push(character);
    }
    escaped
}

#[derive(Debug, Serialize)]
// 表示管理列表中的内容条目，供列表响应序列化。
pub struct AdminContentItem {
    pub id: String,
    pub is_private: bool,
    pub kind: String,
    pub name: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub poster_url: Option<String>,
}

#[derive(Debug, Serialize)]
// 表示管理内容分页结果，供列表路由返回。
pub struct AdminContentPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<AdminContentItem>,
}
