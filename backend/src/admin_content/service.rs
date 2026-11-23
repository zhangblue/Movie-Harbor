use super::dto::{
    BulkActionRequest, BulkActionResponse, BulkActionResult, BulkContentKind, BulkGenreMode,
    BulkGenreProblemReason, BulkGenreSummary, BulkProblem, BulkTarget, BulkTargetProblemReason,
};
use crate::{
    content::{TargetState, apply_target_state},
    entities::{genre, movie, series},
    movies, series as series_domain,
};
use chrono::Utc;
use sea_orm::{DatabaseConnection, DbErr, EntityTrait, QuerySelect, TransactionTrait};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Debug)]
/// 表示批量内容服务失败，供路由区分领域校验与数据库故障。
pub enum BulkActionError {
    Validation(Vec<BulkProblem>),
    Database,
}

impl From<DbErr> for BulkActionError {
    /// 将底层数据库失败收敛为不泄漏内部信息的服务错误。
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

/// 保存已锁定的电影或剧集，供统一校验和写入流程处理混合目标。
enum LockedContent {
    Movie(movie::Model),
    Series(series::Model),
}

/// 关联规范化目标与锁定记录，供写入阶段保留客户端预期版本。
struct LockedTarget {
    target: BulkTarget,
    content: LockedContent,
}

impl LockedContent {
    /// 返回锁定记录的当前版本，供乐观锁问题收集使用。
    fn version(&self) -> i64 {
        match self {
            Self::Movie(value) => value.version,
            Self::Series(value) => value.version,
        }
    }

    /// 返回锁定记录的生命周期状态，供归档前置条件校验使用。
    fn status(&self) -> &str {
        match self {
            Self::Movie(value) => &value.status,
            Self::Series(value) => &value.status,
        }
    }
}

/// 在单一事务中校验并执行批量动作，任何问题都会使全部目标保持原状。
pub async fn execute_bulk_action(
    db: &DatabaseConnection,
    request: BulkActionRequest,
) -> Result<BulkActionResponse, BulkActionError> {
    let tx = db.begin().await?;
    let mut targets = request.targets().to_vec();
    targets.sort_by_key(|target| (target.kind, target.id));
    let mut problems = Vec::new();
    let mut locked = Vec::with_capacity(targets.len());

    // 先按统一 kind+id 顺序取得所有内容锁；客户端排列不同也不会改变数据库锁顺序。
    for target in targets {
        let content = match target.kind {
            BulkContentKind::Movie => movies::repository::find_locked_optional(&tx, target.id)
                .await?
                .map(LockedContent::Movie),
            BulkContentKind::Series => {
                series_domain::repository::find_locked_optional(&tx, target.id)
                    .await?
                    .map(LockedContent::Series)
            }
        };
        let Some(content) = content else {
            problems.push(BulkProblem::Target {
                kind: target.kind,
                id: target.id,
                reason: BulkTargetProblemReason::NotFound,
            });
            continue;
        };
        if content.version() != target.version {
            problems.push(BulkProblem::Target {
                kind: target.kind,
                id: target.id,
                reason: BulkTargetProblemReason::VersionConflict,
            });
        } else if matches!(request, BulkActionRequest::Archive { .. })
            && content.status() != "published"
        {
            problems.push(BulkProblem::Target {
                kind: target.kind,
                id: target.id,
                reason: BulkTargetProblemReason::InvalidState,
            });
        }
        locked.push(LockedTarget { target, content });
    }

    // 题材也按 UUID 固定顺序锁定；移除允许停用题材，添加则将其作为完整问题返回。
    if let BulkActionRequest::UpdateGenres {
        mode, genre_ids, ..
    } = &request
    {
        let mut normalized = genre_ids.clone();
        normalized.sort_unstable();
        for genre_id in normalized {
            match genre::Entity::find_by_id(genre_id)
                .lock_exclusive()
                .one(&tx)
                .await?
            {
                None => problems.push(BulkProblem::Genre {
                    genre_id,
                    reason: BulkGenreProblemReason::NotFound,
                }),
                Some(value) if *mode == BulkGenreMode::Add && !value.enabled => {
                    problems.push(BulkProblem::Genre {
                        genre_id,
                        reason: BulkGenreProblemReason::Inactive,
                    });
                }
                Some(_) => {}
            }
        }
    }

    if !problems.is_empty() {
        // 显式回滚可尽早释放全部行锁，避免失败请求阻塞后续管理员操作。
        tx.rollback().await?;
        return Err(BulkActionError::Validation(problems));
    }

    let mut results = Vec::with_capacity(locked.len());
    for locked_target in locked {
        let result = apply_action(&tx, &request, locked_target).await?;
        results.push(result);
    }
    // 只有所有目标写入和响应摘要读取均成功后才提交，确保客户端看到的结果对应同一原子批次。
    tx.commit().await?;
    Ok(BulkActionResponse { results })
}

/// 对单个已锁定目标应用动作并构造最终摘要，调用方负责统一事务提交。
async fn apply_action(
    tx: &sea_orm::DatabaseTransaction,
    request: &BulkActionRequest,
    locked: LockedTarget,
) -> Result<BulkActionResult, BulkActionError> {
    match locked.content {
        LockedContent::Movie(mut value) => {
            let updated = if let BulkActionRequest::SetPrivacy { is_private, .. } = request {
                // 隐私字段独立于普通内容持久化，必须调用专用条件更新才能真正写入该字段。
                movies::repository::set_privacy(tx, value.id, locked.target.version, *is_private)
                    .await
                    .map_err(|_| BulkActionError::Database)?
            } else {
                apply_model_fields(
                    request,
                    &mut value.status,
                    &mut value.published_at,
                    &mut value.archived_at,
                );
                movies::repository::persist(tx, &value, locked.target.version)
                    .await
                    .map_err(|_| BulkActionError::Database)?
            };
            update_movie_genres(tx, request, updated.id).await?;
            let genres = movies::repository::genres(tx, updated.id)
                .await
                .map_err(|_| BulkActionError::Database)?;
            Ok(result_from_movie(updated, genres))
        }
        LockedContent::Series(mut value) => {
            let updated = if let BulkActionRequest::SetPrivacy { is_private, .. } = request {
                // 剧集普通持久化同样不含隐私字段，专用更新在当前外层事务中只递增一次版本。
                series_domain::repository::set_privacy(
                    tx,
                    value.id,
                    locked.target.version,
                    *is_private,
                )
                .await
                .map_err(|_| BulkActionError::Database)?
            } else {
                apply_model_fields(
                    request,
                    &mut value.status,
                    &mut value.published_at,
                    &mut value.archived_at,
                );
                series_domain::repository::persist_series(tx, &value, locked.target.version)
                    .await
                    .map_err(|_| BulkActionError::Database)?
            };
            update_series_genres(tx, request, updated.id).await?;
            let genres = series_domain::repository::genres(tx, updated.id)
                .await
                .map_err(|_| BulkActionError::Database)?;
            Ok(result_from_series(updated, genres))
        }
    }
}

/// 将访问范围或归档动作写入模型字段，题材动作保留字段但仍由持久化递增版本。
fn apply_model_fields(
    request: &BulkActionRequest,
    status: &mut String,
    published_at: &mut Option<chrono::DateTime<chrono::FixedOffset>>,
    archived_at: &mut Option<chrono::DateTime<chrono::FixedOffset>>,
) {
    match request {
        BulkActionRequest::SetPrivacy { .. } => {}
        BulkActionRequest::Archive { .. } => apply_target_state(
            status,
            published_at,
            archived_at,
            TargetState::Archived,
            Utc::now().fixed_offset(),
        ),
        BulkActionRequest::UpdateGenres { .. } => {}
    }
}

/// 按添加或移除语义更新电影题材集合，无效果操作仍由外层电影持久化递增一次版本。
async fn update_movie_genres(
    tx: &sea_orm::DatabaseTransaction,
    request: &BulkActionRequest,
    id: Uuid,
) -> Result<(), BulkActionError> {
    let BulkActionRequest::UpdateGenres {
        mode, genre_ids, ..
    } = request
    else {
        return Ok(());
    };
    let current = movies::repository::genres(tx, id)
        .await
        .map_err(|_| BulkActionError::Database)?;
    let next = update_genre_set(current.into_iter().map(|genre| genre.id), *mode, genre_ids);
    movies::repository::replace_genres(tx, id, &next)
        .await
        .map_err(|_| BulkActionError::Database)
}

/// 按添加或移除语义更新剧集题材集合，无效果操作仍由外层剧集持久化递增一次版本。
async fn update_series_genres(
    tx: &sea_orm::DatabaseTransaction,
    request: &BulkActionRequest,
    id: Uuid,
) -> Result<(), BulkActionError> {
    let BulkActionRequest::UpdateGenres {
        mode, genre_ids, ..
    } = request
    else {
        return Ok(());
    };
    let current = series_domain::repository::genres(tx, id)
        .await
        .map_err(|_| BulkActionError::Database)?;
    let next = update_genre_set(current.into_iter().map(|genre| genre.id), *mode, genre_ids);
    series_domain::repository::replace_genres(tx, id, &next)
        .await
        .map_err(|_| BulkActionError::Database)
}

/// 计算题材集合的稳定 UUID 顺序，供电影和剧集共享相同增删语义。
fn update_genre_set(
    current: impl Iterator<Item = Uuid>,
    mode: BulkGenreMode,
    genre_ids: &[Uuid],
) -> Vec<Uuid> {
    let mut values = current.collect::<BTreeSet<_>>();
    for genre_id in genre_ids {
        match mode {
            BulkGenreMode::Add => {
                values.insert(*genre_id);
            }
            BulkGenreMode::Remove => {
                values.remove(genre_id);
            }
        }
    }
    values.into_iter().collect()
}

/// 将电影模型与稳定排序题材转换为批量成功条目。
fn result_from_movie(value: movie::Model, genres: Vec<genre::Model>) -> BulkActionResult {
    BulkActionResult {
        kind: BulkContentKind::Movie,
        id: value.id,
        version: value.version,
        status: value.status,
        is_private: value.is_private,
        genres: genre_summaries(genres),
    }
}

/// 将剧集模型与稳定排序题材转换为批量成功条目。
fn result_from_series(value: series::Model, genres: Vec<genre::Model>) -> BulkActionResult {
    BulkActionResult {
        kind: BulkContentKind::Series,
        id: value.id,
        version: value.version,
        status: value.status,
        is_private: value.is_private,
        genres: genre_summaries(genres),
    }
}

/// 将题材模型缩减为不暴露管理字段的批量响应摘要。
fn genre_summaries(values: Vec<genre::Model>) -> Vec<BulkGenreSummary> {
    values
        .into_iter()
        .map(|value| BulkGenreSummary {
            id: value.id,
            name: value.name,
        })
        .collect()
}
