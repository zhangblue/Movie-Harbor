use crate::entities::viewer_user;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PAGE_SIZE: u64 = 20;
const MAX_PAGE: u64 = 1_000_000;

#[derive(Default, Deserialize)]
// 承载普通用户管理列表参数，供管理路由解析请求。
pub struct ViewerUserRequest {
    pub q: Option<String>,
    pub page: Option<u64>,
    pub size: Option<u64>,
}

// 保存已校验的用户筛选和分页条件，供用户列表查询使用。
pub struct ViewerUserFilter {
    pub pattern: Option<String>,
    pub page: u64,
    pub offset: u64,
}

impl TryFrom<ViewerUserRequest> for ViewerUserFilter {
    // 指定用户列表参数转换失败使用的领域错误，供请求校验返回。
    type Error = super::service::ViewerUserError;

    // 校验并转换用户列表请求，供管理列表查询前调用。
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
// 承载普通用户账号与密码，供创建用户路由解析请求。
pub struct CreateViewerRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
// 承载版本和新密码，供管理员重置普通用户密码时解析。
pub struct AdminPasswordRequest {
    pub version: i64,
    pub new_password: String,
}

#[derive(Deserialize)]
// 承载用户版本，供管理员删除用户时并发校验。
pub struct DeleteViewerRequest {
    pub version: i64,
}

#[derive(Serialize)]
// 承载普通用户摘要，供管理列表和变更响应返回。
pub struct ViewerUserSummary {
    pub id: Uuid,
    pub username: String,
    pub version: i64,
    pub created_at: String,
    pub last_login_at: Option<String>,
    pub has_active_session: bool,
}

impl From<viewer_user::Model> for ViewerUserSummary {
    // 将用户实体转换为摘要，供账号创建和修改结果返回时调用。
    fn from(user: viewer_user::Model) -> Self {
        Self {
            id: user.id,
            username: user.username,
            version: user.version,
            created_at: user.created_at.to_rfc3339(),
            last_login_at: user.last_login_at.map(|value| value.to_rfc3339()),
            has_active_session: false,
        }
    }
}

#[derive(Serialize)]
// 承载用户总体统计，供管理列表响应使用。
pub struct ViewerUserOverview {
    pub total_users: u64,
    pub active_users: u64,
    pub latest_user: Option<ViewerUserSummary>,
}

#[derive(Serialize)]
// 承载用户分页和总体统计，供管理列表路由返回。
pub struct ViewerUserPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<ViewerUserSummary>,
    pub summary: ViewerUserOverview,
}
