use super::dto::{
    PAGE_SIZE, ViewerUserFilter, ViewerUserOverview, ViewerUserPage, ViewerUserSummary,
};
use crate::{
    auth::{AuthState, password},
    entities::{viewer_session, viewer_user},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, FromQueryResult, IsolationLevel,
    QueryFilter, QuerySelect, Set, SqlErr, Statement, TransactionTrait,
};
use uuid::Uuid;

#[derive(Debug)]
pub enum ViewerUserError {
    Invalid,
    NotFound,
    Conflict,
    Database,
}

impl From<DbErr> for ViewerUserError {
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl From<crate::auth::model::AuthError> for ViewerUserError {
    fn from(_: crate::auth::model::AuthError) -> Self {
        Self::Database
    }
}

impl IntoResponse for ViewerUserError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "用户管理请求无效"),
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
        .map(|row| ViewerUserSummary::from_query_result(row, ""))
        .collect::<Result<Vec<_>, _>>()?;
    let latest_user = tx.query_one(Statement::from_string(DatabaseBackend::Postgres,
        format!("SELECT {USER_COLUMNS} FROM viewer_user u ORDER BY u.created_at DESC, u.id ASC LIMIT 1"))).await?
        .as_ref().map(|row| ViewerUserSummary::from_query_result(row, "")).transpose()?;
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

pub async fn create(
    state: &AuthState,
    username: String,
    password: String,
) -> Result<ViewerUserSummary, ViewerUserError> {
    let username = username.trim().to_owned();
    if username.is_empty() || password.trim().is_empty() {
        return Err(ViewerUserError::Invalid);
    }
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

pub async fn change_password(
    state: &AuthState,
    id: Uuid,
    version: i64,
    password: String,
) -> Result<ViewerUserSummary, ViewerUserError> {
    if version <= 0 || password.trim().is_empty() {
        return Err(ViewerUserError::Invalid);
    }
    // CPU 密集计算在锁外执行；真正写入前必须在用户锁内重新校验并发版本。
    let hash = password::hash_limited(&state.password_work, password).await?;
    let tx = state.db.begin().await?;
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
    viewer_session::Entity::delete_many()
        .filter(viewer_session::Column::ViewerUserId.eq(id))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    Ok(user.into())
}

pub async fn delete(
    db: &DatabaseConnection,
    id: Uuid,
    version: i64,
) -> Result<(), ViewerUserError> {
    if version <= 0 {
        return Err(ViewerUserError::Invalid);
    }
    let tx = db.begin().await?;
    locked_user(&tx, id, version).await?;
    // 删除用户与外键级联会话在同一事务提交，和登录、改密共用用户行锁。
    viewer_user::Entity::delete_by_id(id).exec(&tx).await?;
    tx.commit().await?;
    Ok(())
}
