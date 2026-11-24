use crate::entities::{genre, movie_genre, series_genre};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr,
    EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, SqlErr,
    TransactionTrait,
};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug)]
// 表示题材校验、冲突与数据库错误，供题材服务和路由使用。
pub enum GenreError {
    Invalid,
    NotFound,
    Conflict,
    Inactive,
    Database,
}

impl From<DbErr> for GenreError {
    // 将数据库错误映射为题材错误，供服务查询失败时调用。
    fn from(error: DbErr) -> Self {
        // 创建或改名触发的数据库唯一约束统一映射为可恢复的题材冲突。
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl IntoResponse for GenreError {
    // 将题材错误转换为 HTTP 响应，供题材路由失败时调用。
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid genre request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "genre not found"),
            Self::Conflict => (StatusCode::CONFLICT, "genre is in use or already exists"),
            Self::Inactive => (StatusCode::UNPROCESSABLE_ENTITY, "genre is inactive"),
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}

// 按顺序读取题材列表，供题材管理路由调用。
pub async fn list<C: ConnectionTrait>(db: &C) -> Result<Vec<genre::Model>, GenreError> {
    Ok(genre::Entity::find()
        .order_by_asc(genre::Column::SortOrder)
        .order_by_asc(genre::Column::Id)
        .all(db)
        .await?)
}

// 校验并创建题材，供管理员创建题材时调用。
pub async fn create(db: &DatabaseConnection, name: String) -> Result<genre::Model, GenreError> {
    let name = normalized_name(name)?;
    let tx = db.begin().await?;
    // 题材集合（包括空表）需要防止并发插入，SeaORM 的行锁无法覆盖该范围。
    tx.execute_unprepared("LOCK TABLE genre IN EXCLUSIVE MODE")
        .await?;
    let last = genre::Entity::find()
        .order_by_desc(genre::Column::SortOrder)
        .one(&tx)
        .await?;
    let model = genre::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        sort_order: Set(last.map_or(1, |genre| genre.sort_order.saturating_add(1))),
        enabled: Set(true),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    Ok(model)
}

// 校验并修改题材名称，供管理员重命名时调用。
pub async fn rename(
    db: &DatabaseConnection,
    id: Uuid,
    name: String,
) -> Result<genre::Model, GenreError> {
    let name = normalized_name(name)?;
    let model = genre::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(GenreError::NotFound)?;
    let mut active: genre::ActiveModel = model.into();
    active.name = Set(name);
    active.updated_at = Set(Utc::now().fixed_offset());
    Ok(active.update(db).await?)
}

// 停用题材，供管理员管理题材时调用。
pub async fn deactivate(db: &DatabaseConnection, id: Uuid) -> Result<genre::Model, GenreError> {
    let model = genre::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(GenreError::NotFound)?;
    if !model.enabled {
        return Ok(model);
    }
    // 停用只阻止后续关联选择，已有电影和剧集仍保留这项历史题材。
    let mut active: genre::ActiveModel = model.into();
    active.enabled = Set(false);
    active.updated_at = Set(Utc::now().fixed_offset());
    Ok(active.update(db).await?)
}

// 事务内更新题材顺序，供管理员排序时调用。
pub async fn reorder(
    db: &DatabaseConnection,
    requested: Vec<(Uuid, i32)>,
) -> Result<Vec<genre::Model>, GenreError> {
    if requested.is_empty()
        || requested.iter().any(|(_, position)| *position <= 0)
        || requested
            .iter()
            .map(|(_, position)| position)
            .collect::<HashSet<_>>()
            .len()
            != requested.len()
        || requested
            .iter()
            .map(|(id, _)| id)
            .collect::<HashSet<_>>()
            .len()
            != requested.len()
    {
        return Err(GenreError::Invalid);
    }

    // 重排请求必须覆盖全部现有题材，避免遗漏或重复位置留下不可判定的系统顺序。
    let tx = db.begin().await?;
    // 题材集合（包括空表）需要防止并发插入，SeaORM 的行锁无法覆盖该范围。
    tx.execute_unprepared("LOCK TABLE genre IN EXCLUSIVE MODE")
        .await?;
    let current = genre::Entity::find().all(&tx).await?;
    let current_ids = current.iter().map(|genre| genre.id).collect::<HashSet<_>>();
    let requested_ids = requested.iter().map(|(id, _)| *id).collect::<HashSet<_>>();
    if requested_ids != current_ids {
        return Err(GenreError::Invalid);
    }

    for (id, sort_order) in requested {
        let mut active: genre::ActiveModel = current
            .iter()
            .find(|genre| genre.id == id)
            .cloned()
            .ok_or(GenreError::Invalid)?
            .into();
        active.sort_order = Set(sort_order);
        active.updated_at = Set(Utc::now().fixed_offset());
        active.update(&tx).await?;
    }
    let result = list(&tx).await?;
    tx.commit().await?;
    Ok(result)
}

// 按关联约束删除题材，供管理员删除时调用。
pub async fn delete(db: &DatabaseConnection, id: Uuid) -> Result<(), GenreError> {
    let tx = db.begin().await?;
    let model = genre::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&tx)
        .await?
        .ok_or(GenreError::NotFound)?;
    // 删除前检查两种父内容的关联；仍被引用的题材只能停用，不能破坏历史数据。
    let movie_reference = movie_genre::Entity::find()
        .filter(movie_genre::Column::GenreId.eq(id))
        .one(&tx)
        .await?;
    let series_reference = series_genre::Entity::find()
        .filter(series_genre::Column::GenreId.eq(id))
        .one(&tx)
        .await?;
    if movie_reference.is_some() || series_reference.is_some() {
        return Err(GenreError::Conflict);
    }
    genre::Entity::delete(model.into_active_model())
        .exec(&tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// 在将要写入关联表的事务内锁定并校验题材 ID。
///
/// 调用方必须让 `tx` 持续到关联表插入和提交完成。共享行锁会与停用操作的 `UPDATE`
/// 冲突，从而原子地确定关联与停用的先后顺序。
// 校验题材可用于关联，供内容保存关联前在事务中调用。
pub async fn ensure_associable(tx: &DatabaseTransaction, ids: &[Uuid]) -> Result<(), GenreError> {
    let distinct = ids.iter().copied().collect::<HashSet<_>>();
    if distinct.len() != ids.len() {
        return Err(GenreError::Invalid);
    }
    // 锁住题材行直到关联写入完成，避免“检查为启用”后立刻被并发停用。
    let found = genre::Entity::find()
        .filter(genre::Column::Id.is_in(distinct))
        .lock_shared()
        .all(tx)
        .await?;
    if found.len() != ids.len() {
        return Err(GenreError::NotFound);
    }
    if found.iter().any(|genre| !genre.enabled) {
        return Err(GenreError::Inactive);
    }
    Ok(())
}

// 描述一次内容题材替换的最终关联与新增关联，供公共替换准备逻辑区分校验范围。
struct GenreReplacementPlan {
    ids: Vec<Uuid>,
    newly_added: Vec<Uuid>,
}

// 计算题材替换计划，供电影和剧集更新共同保留历史停用题材并识别新增关联。
fn plan_replacement(
    existing: &[genre::Model],
    requested: Option<Vec<Uuid>>,
) -> Option<GenreReplacementPlan> {
    let mut requested = requested?;
    let existing_ids = existing
        .iter()
        .map(|genre| genre.id)
        .collect::<HashSet<_>>();
    let newly_added = requested
        .iter()
        .copied()
        .filter(|id| !existing_ids.contains(id))
        .collect::<Vec<_>>();
    for genre in existing.iter().filter(|genre| !genre.enabled) {
        if !requested.contains(&genre.id) {
            requested.push(genre.id);
        }
    }
    Some(GenreReplacementPlan {
        ids: requested,
        newly_added,
    })
}

/// 在内容更新事务中准备题材替换，供电影和剧集共享新增题材校验与停用题材保留规则。
///
/// `requested` 必须先完成 UUID 解析和去重；`existing` 必须在内容行锁定后通过同一事务读取，
/// 返回的关联标识也必须在该事务提交前写入，才能保持题材停用与内容更新的原子顺序。
pub async fn prepare_replacement(
    tx: &DatabaseTransaction,
    existing: &[genre::Model],
    requested: Option<Vec<Uuid>>,
) -> Result<Option<Vec<Uuid>>, GenreError> {
    let Some(plan) = plan_replacement(existing, requested) else {
        return Ok(None);
    };
    // 只校验本次新增的关联；历史停用题材允许继续保留，但不能重新添加到其他内容。
    if !plan.newly_added.is_empty() {
        ensure_associable(tx, &plan.newly_added).await?;
    }
    Ok(Some(plan.ids))
}

// 规范化并校验题材名称，供创建和重命名前调用。
fn normalized_name(name: String) -> Result<String, GenreError> {
    let name = name.trim();
    if name.is_empty() {
        Err(GenreError::Invalid)
    } else {
        Ok(name.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::plan_replacement;
    use crate::entities::genre;
    use chrono::Utc;
    use uuid::Uuid;

    // 构造真实题材模型，供题材替换计划测试覆盖启用状态和标识归类。
    fn genre(id: Uuid, enabled: bool) -> genre::Model {
        let now = Utc::now().fixed_offset();
        genre::Model {
            id,
            name: id.to_string(),
            sort_order: 1,
            enabled,
            created_at: now,
            updated_at: now,
        }
    }

    // 验证替换计划只校验新增题材，并保留未被请求显式选择的历史停用题材。
    #[test]
    fn replacement_plan_preserves_inactive_existing_genres_and_identifies_additions() {
        let active_existing = Uuid::from_u128(1);
        let inactive_existing = Uuid::from_u128(2);
        let requested_new = Uuid::from_u128(3);
        let existing = [
            genre(active_existing, true),
            genre(inactive_existing, false),
        ];

        let plan = plan_replacement(&existing, Some(vec![active_existing, requested_new]))
            .expect("显式提交题材时应生成替换计划");

        assert_eq!(plan.newly_added, vec![requested_new]);
        assert_eq!(
            plan.ids,
            vec![active_existing, requested_new, inactive_existing]
        );
    }
}
