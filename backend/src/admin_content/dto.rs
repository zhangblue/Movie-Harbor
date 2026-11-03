use serde::{Deserialize, Serialize};

pub const ADMIN_CONTENT_PAGE_SIZE: u64 = 20;
pub const MAX_ADMIN_CONTENT_PAGE: u64 = 1_000_000;

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
