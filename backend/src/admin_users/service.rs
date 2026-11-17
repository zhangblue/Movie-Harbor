use super::dto::{
    PAGE_SIZE, ViewerUserFilter, ViewerUserOverview, ViewerUserPage, ViewerUserSummary,
};
use crate::{
    auth::{AuthState, password},
    entities::{viewer_session, viewer_user},
    viewer_auth::password_policy,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, FixedOffset};
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, DbErr,
    EntityTrait, FromQueryResult, IsolationLevel, QueryFilter, QueryOrder, QuerySelect, Select,
    Set, SqlErr, TransactionTrait,
    sea_query::{Asterisk, CaseStatement, Expr, LikeExpr, Query, SimpleExpr},
};
use uuid::Uuid;

#[derive(Debug)]
// 表示普通用户管理中的校验、冲突和数据库错误，供服务及路由使用。
pub enum ViewerUserError {
    Invalid,
    InvalidPassword,
    NotFound,
    Conflict,
    Database,
}

impl From<DbErr> for ViewerUserError {
    // 在用户管理数据库操作失败时，将唯一约束冲突映射为冲突响应，其余错误归为数据库故障。
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl From<crate::auth::model::AuthError> for ViewerUserError {
    // 在创建或重置用户密码的哈希处理失败时，将底层认证错误统一映射为内部故障。
    fn from(_: crate::auth::model::AuthError) -> Self {
        Self::Database
    }
}

impl IntoResponse for ViewerUserError {
    // 将用户管理错误转换为 HTTP 响应，供路由失败时调用。
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "用户管理请求无效"),
            Self::InvalidPassword => return password_policy::InvalidPassword.into_response(),
            Self::NotFound => (StatusCode::NOT_FOUND, "用户不存在"),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "用户名已存在或用户信息已变化，请刷新后重试",
            ),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}

// 构造与用户关联的有效会话存在条件，供列表和总览使用同一数据库时钟。
fn has_active_session() -> SimpleExpr {
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from(viewer_session::Entity)
            .and_where(
                Expr::col((viewer_session::Entity, viewer_session::Column::ViewerUserId))
                    .equals((viewer_user::Entity, viewer_user::Column::Id)),
            )
            .and_where(
                Expr::col((viewer_session::Entity, viewer_session::Column::ExpiresAt))
                    .gt(Expr::current_timestamp()),
            )
            .take(),
    )
}

// 构造用户摘要的稳定查询顺序，供分页和最新用户概览复用。
fn summaries() -> Select<viewer_user::Entity> {
    use viewer_user::Column;
    viewer_user::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Username,
            Column::Version,
            Column::CreatedAt,
            Column::LastLoginAt,
        ])
        .expr_as(has_active_session(), "has_active_session")
        .order_by_desc(Column::CreatedAt)
        .order_by_asc(Column::Id)
}

// 承载同一查询快照中的全局及筛选计数，供列表和概览转换使用。
#[derive(FromQueryResult)]
struct ViewerUserCounts {
    total_users: i64,
    active_users: i64,
    matching_users: i64,
}

// 数据库时间类型停留在查询边界，响应使用项目统一的 RFC 3339 字符串格式。
#[derive(FromQueryResult)]
// 承载用户统计查询行，供转换管理列表摘要使用。
struct ViewerUserRow {
    id: Uuid,
    username: String,
    version: i64,
    created_at: DateTime<FixedOffset>,
    last_login_at: Option<DateTime<FixedOffset>>,
    has_active_session: bool,
}

impl From<ViewerUserRow> for ViewerUserSummary {
    // 在管理列表与概览组装响应时，将查询行转为用户摘要并统一序列化时间。
    fn from(row: ViewerUserRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            version: row.version,
            created_at: row.created_at.to_rfc3339(),
            last_login_at: row.last_login_at.map(|value| value.to_rfc3339()),
            has_active_session: row.has_active_session,
        }
    }
}

// 在一致性快照中查询用户分页与概览，供管理列表路由调用。
pub async fn list(
    db: &DatabaseConnection,
    filter: ViewerUserFilter,
) -> Result<ViewerUserPage, ViewerUserError> {
    // 分页总数、条目及全局概览来自同一只读快照，活跃用户按有效会话去重计算。
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let search = filter.pattern.map(|pattern| {
        Expr::col((viewer_user::Entity, viewer_user::Column::NormalizedUsername))
            .like(LikeExpr::new(pattern).escape('!'))
    });
    // CASE 只给满足条件的用户产生非空值，COUNT 因此只计算匹配用户，各会话不会重复计数。
    let matching_count = match &search {
        Some(condition) => Expr::expr(CaseStatement::new().case(condition.clone(), 1)).count(),
        None => Expr::col(Asterisk).count(),
    };
    let counts = viewer_user::Entity::find()
        .select_only()
        .expr_as(Expr::col(Asterisk).count(), "total_users")
        .expr_as(
            Expr::expr(CaseStatement::new().case(has_active_session(), 1)).count(),
            "active_users",
        )
        .expr_as(matching_count, "matching_users")
        .into_model::<ViewerUserCounts>()
        .one(&tx)
        .await?
        .ok_or(ViewerUserError::Database)?;
    let count = |value: i64| u64::try_from(value).map_err(|_| ViewerUserError::Database);
    let total = count(counts.matching_users)?;
    let total_users = count(counts.total_users)?;
    let active_users = count(counts.active_users)?;
    let mut page = summaries();
    if let Some(search) = search {
        page = page.filter(search);
    }
    let items = page
        .limit(PAGE_SIZE)
        .offset(filter.offset)
        .into_model::<ViewerUserRow>()
        .all(&tx)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    let latest_user = summaries()
        .into_model::<ViewerUserRow>()
        .one(&tx)
        .await?
        .map(Into::into);
    tx.commit().await?;
    Ok(ViewerUserPage {
        page: filter.page,
        size: PAGE_SIZE,
        total,
        items,
        summary: ViewerUserOverview {
            total_users,
            active_users,
            latest_user,
        },
    })
}

// 校验并创建普通用户，供管理员创建账号时调用。
pub async fn create(
    state: &AuthState,
    username: String,
    password: String,
) -> Result<ViewerUserSummary, ViewerUserError> {
    let username = username.trim().to_owned();
    if username.is_empty() {
        return Err(ViewerUserError::Invalid);
    }
    // 创建前先拒绝不符合规则的密码，再计算哈希，避免开启必然失败的写事务。
    password_policy::validate(&password).map_err(|_| ViewerUserError::InvalidPassword)?;
    let hash = password::hash_limited(&state.password_work, password).await?;
    let tx = state.db.begin().await?;
    // 普通用户唯一索引作为并发创建的最终裁决；管理员用户名不参与此约束。
    let model = viewer_user::ActiveModel {
        id: Set(Uuid::new_v4()),
        normalized_username: Set(username.to_lowercase()),
        username: Set(username),
        password_hash: Set(hash),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    Ok(model.into())
}

// 锁定用户并校验版本，供改密或删除事务写入前调用。
async fn locked_user(
    tx: &DatabaseTransaction,
    id: Uuid,
    version: i64,
) -> Result<viewer_user::Model, ViewerUserError> {
    let user = viewer_user::Entity::find_by_id(id)
        .lock_exclusive()
        .one(tx)
        .await?
        .ok_or(ViewerUserError::NotFound)?;
    if user.version != version {
        return Err(ViewerUserError::Conflict);
    }
    Ok(user)
}

// 重置用户密码并撤销所有会话，供管理员改密路由调用。
pub async fn change_password(
    state: &AuthState,
    id: Uuid,
    version: i64,
    password: String,
) -> Result<ViewerUserSummary, ViewerUserError> {
    if version <= 0 {
        return Err(ViewerUserError::Invalid);
    }
    password_policy::validate(&password).map_err(|_| ViewerUserError::InvalidPassword)?;
    // CPU 密集计算在锁外执行；真正写入前必须在用户锁内重新校验并发版本。
    let hash = password::hash_limited(&state.password_work, password).await?;
    let tx = state.db.begin().await?;
    // 在事务中锁定用户并重验版本；冲突时不更新密码或撤销会话。
    let user = locked_user(&tx, id, version).await?;
    let next_version = user
        .version
        .checked_add(1)
        .ok_or(ViewerUserError::Conflict)?;
    let mut model: viewer_user::ActiveModel = user.into();
    model.password_hash = Set(hash);
    model.version = Set(next_version);
    model.updated_at = Set(chrono::Utc::now().fixed_offset());
    let user = model.update(&tx).await?;
    // 密码变更与会话撤销同事务提交，失败时两者均不生效。
    viewer_session::Entity::delete_many()
        .filter(viewer_session::Column::ViewerUserId.eq(id))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    Ok(user.into())
}

// 按版本删除用户及其会话，供管理员删除路由调用。
pub async fn delete(
    db: &DatabaseConnection,
    id: Uuid,
    version: i64,
) -> Result<(), ViewerUserError> {
    if version <= 0 {
        return Err(ViewerUserError::Invalid);
    }
    let tx = db.begin().await?;
    // 删除前在用户行锁内校验版本，使并发改密或删除先完成的一方决定本次请求是否仍有效。
    locked_user(&tx, id, version).await?;
    // 删除用户与外键级联会话在同一事务提交，和登录、改密共用用户行锁。
    viewer_user::Entity::delete_by_id(id).exec(&tx).await?;
    tx.commit().await?;
    Ok(())
}
