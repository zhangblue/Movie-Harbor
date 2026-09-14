use serde::{Deserialize, Serialize};

pub const ADMIN_CONTENT_PAGE_SIZE: u64 = 20;
pub const MAX_ADMIN_CONTENT_PAGE: u64 = 1_000_000;

#[derive(Debug, Default, Deserialize)]
pub struct AdminContentRequest {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub name: Option<String>,
    pub page: Option<u64>,
}

pub struct AdminContentFilter {
    pub kind: String,
    pub status: Option<String>,
    pub name_pattern: Option<String>,
    pub page: u64,
    pub offset: u64,
}

impl TryFrom<AdminContentRequest> for AdminContentFilter {
    type Error = ();

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
            name_pattern,
            page,
            offset,
        })
    }
}

fn escape_like(value: &str) -> String {
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
pub struct AdminContentItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub poster_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AdminContentPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<AdminContentItem>,
}
