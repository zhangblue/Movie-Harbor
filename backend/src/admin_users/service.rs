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
    AccessMode, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, FromQueryResult, IsolationLevel,
    QueryFilter, QuerySelect, Set, SqlErr, Statement, TransactionTrait,
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

const USER_COLUMNS: &str = "u.id, u.username, u.version, u.created_at, u.last_login_at,
    EXISTS (SELECT 1 FROM viewer_session s WHERE s.viewer_user_id = u.id AND s.expires_at > CURRENT_TIMESTAMP) AS has_active_session";

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
    let counts = tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT count(*)::bigint AS total_users,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM viewer_session s WHERE s.viewer_user_id = u.id AND s.expires_at > CURRENT_TIMESTAMP))::bigint AS active_users,
        count(*) FILTER (WHERE $1::text IS NULL OR u.normalized_username LIKE $1::text ESCAPE '!')::bigint AS total
        FROM viewer_user u", [filter.pattern.clone().into()])).await?.ok_or(ViewerUserError::Database)?;
    // 在组装分页和概览前读取非负计数；字段读取或数值转换失败时中止本次查询响应。
    let count = |key: &str| -> Result<u64, ViewerUserError> {
        u64::try_from(counts.try_get::<i64>("", key)?).map_err(|_| ViewerUserError::Database)
    };
    let total = count("total")?;
    let total_users = count("total_users")?;
    let active_users = count("active_users")?;
    // SQL 结构只拼接固定列，搜索、LIMIT 和 OFFSET 均使用绑定参数。
    let rows = tx.query_all(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        format!("SELECT {USER_COLUMNS} FROM viewer_user u WHERE $1::text IS NULL OR u.normalized_username LIKE $1::text ESCAPE '!' ORDER BY u.created_at DESC, u.id ASC LIMIT $2 OFFSET $3"),
        [filter.pattern.into(), (PAGE_SIZE as i64).into(), (filter.offset as i64).into()])).await?;
    let items = rows
        .iter()
        .map(|row| ViewerUserRow::from_query_result(row, "").map(Into::into))
        .collect::<Result<Vec<_>, _>>()?;
    let latest_user = tx.query_one(Statement::from_string(DatabaseBackend::Postgres,
        format!("SELECT {USER_COLUMNS} FROM viewer_user u ORDER BY u.created_at DESC, u.id ASC LIMIT 1"))).await?
        .as_ref().map(|row| ViewerUserRow::from_query_result(row, "").map(Into::into)).transpose()?;
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
