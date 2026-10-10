use crate::entities::viewer_user;
use chrono::{DateTime, FixedOffset};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PAGE_SIZE: u64 = 20;
const MAX_PAGE: u64 = 1_000_000;

#[derive(Default, Deserialize)]
pub struct ViewerUserRequest {
    pub q: Option<String>,
    pub page: Option<u64>,
    pub size: Option<u64>,
}

pub struct ViewerUserFilter {
    pub pattern: Option<String>,
    pub page: u64,
    pub offset: u64,
}

impl TryFrom<ViewerUserRequest> for ViewerUserFilter {
    type Error = super::service::ViewerUserError;

    fn try_from(request: ViewerUserRequest) -> Result<Self, Self::Error> {
        let page = request.page.unwrap_or(1);
        if !(1..=MAX_PAGE).contains(&page) || request.size.unwrap_or(PAGE_SIZE) != PAGE_SIZE {
            return Err(Self::Error::Invalid);
        }
        let pattern = request
            .q
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty())
            .map(|q| {
                let mut escaped = String::with_capacity(q.len());
                for character in q.chars() {
                    if matches!(character, '!' | '%' | '_') {
                        escaped.push('!');
                    }
                    escaped.push(character);
                }
                format!("%{escaped}%")
            });
        Ok(Self {
            pattern,
            page,
            offset: (page - 1) * PAGE_SIZE,
        })
    }
}

#[derive(Deserialize)]
pub struct CreateViewerRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct AdminPasswordRequest {
    pub version: i64,
    pub new_password: String,
}

#[derive(Deserialize)]
pub struct DeleteViewerRequest {
    pub version: i64,
}

#[derive(Serialize, FromQueryResult)]
pub struct ViewerUserSummary {
    pub id: Uuid,
    pub username: String,
    pub version: i64,
    pub created_at: DateTime<FixedOffset>,
    pub last_login_at: Option<DateTime<FixedOffset>>,
    pub has_active_session: bool,
}

impl From<viewer_user::Model> for ViewerUserSummary {
    fn from(user: viewer_user::Model) -> Self {
        Self {
            id: user.id,
            username: user.username,
            version: user.version,
            created_at: user.created_at,
            last_login_at: user.last_login_at,
            has_active_session: false,
        }
    }
}

#[derive(Serialize)]
pub struct ViewerUserOverview {
    pub total_users: u64,
    pub active_users: u64,
    pub latest_user: Option<ViewerUserSummary>,
}

#[derive(Serialize)]
pub struct ViewerUserPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<ViewerUserSummary>,
    pub summary: ViewerUserOverview,
}
