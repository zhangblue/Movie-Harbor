use crate::{
    content::{
        ContentRuleError, TargetState, apply_optional_i32, apply_target_state, apply_text,
        ensure_transition, normalize_required, parse_target, parse_unique_uuids,
        require_positive_i64, require_version,
    },
    entities::movie,
    genres,
    media::{LocalMediaStorage, is_publishable_asset, removal, staged_poster},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    Set, TransactionTrait,
};
use std::collections::HashSet;
use uuid::Uuid;

use super::{
    dto::{
        CreateMovieRequest, DeleteImpactResponse, DeleteResultResponse, MovieListQuery,
        MovieResponse, UpdateMovieRequest,
    },
    repository,
};

#[derive(Debug)]
/// 电影领域错误，供服务和路由统一表达校验、冲突及存储失败。
pub enum MovieError {
    Invalid,
    NotFound,
    Conflict,
    Validation(Vec<&'static str>),
    MediaDelete,
    MediaDeleteFinalization,
    Database,
}

impl From<DbErr> for MovieError {
    /// 在数据库操作失败时将错误归入电影领域数据库错误。
    fn from(_: DbErr) -> Self {
        Self::Database
    }
}

impl From<ContentRuleError> for MovieError {
    /// 在公共内容规则校验失败时保留无效请求或冲突语义。
    fn from(error: ContentRuleError) -> Self {
        match error {
            ContentRuleError::Invalid => Self::Invalid,
            ContentRuleError::Conflict => Self::Conflict,
        }
    }
}

impl From<genres::service::GenreError> for MovieError {
    /// 在关联题材失败时映射为电影字段校验、冲突或数据库错误。
    fn from(error: genres::service::GenreError) -> Self {
        match error {
            genres::service::GenreError::Invalid => Self::Invalid,
            genres::service::GenreError::NotFound | genres::service::GenreError::Inactive => {
                Self::Validation(vec!["genres"])
            }
            genres::service::GenreError::Conflict => Self::Conflict,
            genres::service::GenreError::Database => Self::Database,
        }
    }
}

impl IntoResponse for MovieError {
    /// 在路由返回错误时转换为对应的 HTTP 响应。
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid movie request"})),
            )
                .into_response(),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"movie not found"})),
            )
                .into_response(),
            Self::Conflict => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"movie state or version conflict"})),
            )
                .into_response(),
            Self::Validation(fields) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error":"movie validation failed", "fields":fields})),
            )
                .into_response(),
            Self::MediaDelete => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error":"media deletion failed",
                    "code":"media_delete_failed"
                })),
            )
                .into_response(),
            Self::MediaDeleteFinalization => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error":"media deletion finalization failed",
                    "code":"media_delete_finalization_failed"
                })),
            )
                .into_response(),
            Self::Database => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error":"internal server error"})),
            )
                .into_response(),
        }
    }
}

/// 在访问范围变更请求中按版本修改隐私设置并返回更新结果。
pub async fn set_privacy(
    db: &DatabaseConnection,
    id: Uuid,
    expected_version: i64,
    is_private: bool,
) -> Result<MovieResponse, MovieError> {
    require_positive_i64(expected_version)?;
    let tx = db.begin().await?;
    let updated = repository::set_privacy(&tx, id, expected_version, is_private).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在创建请求中建立初始内容并返回响应。
pub async fn create(
    db: &DatabaseConnection,
    name: String,
    is_private: bool,
) -> Result<MovieResponse, MovieError> {
    let name = normalize_required(name)?;
    let model = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        is_private: Set(is_private),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await?;
    response(db, model).await
}

/// 在 MCP 创建内容时校验完整字段并原子消费暂存海报。
pub async fn create_mcp(
    db: &DatabaseConnection,
    input: CreateMovieRequest,
    principal_hash: &str,
) -> Result<MovieResponse, MovieError> {
    let name = normalize_required(input.name).map_err(|_| MovieError::Validation(vec!["name"]))?;
    let synopsis = normalize_required(
        input
            .synopsis
            .ok_or(MovieError::Validation(vec!["synopsis"]))?,
    )
    .map_err(|_| MovieError::Validation(vec!["synopsis"]))?;
    let year = input
        .year
        .filter(|year| (1..=9999).contains(year))
        .ok_or(MovieError::Validation(vec!["year"]))?;
    let duration = input
        .duration_seconds
        .filter(|duration| *duration > 0)
        .ok_or(MovieError::Validation(vec!["duration_seconds"]))?;
    let genre_ids = parse_unique_uuids(input.genre_ids.unwrap_or_default())
        .map_err(|_| MovieError::Validation(vec!["genres"]))?;
    if genre_ids.is_empty() {
        return Err(MovieError::Validation(vec!["genres"]));
    }
    let token = input
        .staged_poster_token
        .filter(|token| !token.trim().is_empty())
        .ok_or(MovieError::Validation(vec!["poster"]))?;
    // 与剧集创建保持一致：先锁暂存海报，再锁题材，内容/独占归属/关系与 token 删除同事务提交。
    let tx = db.begin().await?;
    let poster =
        staged_poster::lock_for_consumption(&tx, &token, principal_hash, Utc::now().fixed_offset())
            .await
            // 令牌不存在、过期或不属于当前主体均提示海报无效，存储故障则保留内部错误语义。
            .map_err(|error| match error {
                staged_poster::StagedPosterError::NotFound => {
                    MovieError::Validation(vec!["poster"])
                }
                staged_poster::StagedPosterError::Media(_) => MovieError::Database,
            })?;
    genres::service::ensure_associable(&tx, &genre_ids).await?;
    // 既有数据库触发器随内容 INSERT 原子建立 media_asset_ownership，禁止跨内容共享海报。
    let model = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        is_private: Set(input.is_private),
        synopsis: Set(synopsis),
        year: Set(Some(year)),
        duration_seconds: Set(Some(duration)),
        poster_asset_id: Set(Some(poster.asset.id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    repository::replace_genres(&tx, model.id, &genre_ids).await?;
    let result = response(&tx, model).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在详情请求中读取指定内容并组装关联数据。
pub async fn detail<C: sea_orm::ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> Result<MovieResponse, MovieError> {
    response(db, repository::find(db, id).await?).await
}

/// 在列表请求中读取符合筛选条件的内容并组装响应。
pub async fn list(
    db: &DatabaseConnection,
    query: MovieListQuery,
) -> Result<Vec<MovieResponse>, MovieError> {
    let mut select = movie::Entity::find().order_by_desc(movie::Column::CreatedAt);
    if let Some(status) = query.status {
        if !matches!(status.as_str(), "draft" | "published" | "archived") {
            return Err(MovieError::Invalid);
        }
        select = select.filter(movie::Column::Status.eq(status));
    }
    if let Some(name) = query.name {
        let name = name.trim();
        if !name.is_empty() {
            select = select.filter(movie::Column::Name.contains(name));
        }
    }
    let mut result = Vec::new();
    for model in select.all(db).await? {
        result.push(response(db, model).await?);
    }
    Ok(result)
}

/// 在编辑请求中校验状态和版本后保存内容。
pub async fn update(
    db: &DatabaseConnection,
    id: Uuid,
    input: UpdateMovieRequest,
) -> Result<MovieResponse, MovieError> {
    require_positive_i64(input.version)?;
    // 草稿更新在同一事务内锁定并校验版本、校验题材、持久化并递增版本、替换题材关联，避免出现部分更新。
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(model.version, input.version)?;
    if model.status != "draft" {
        return Err(MovieError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;
    apply_optional_i32(&mut model.duration_seconds, input.duration_seconds, true)?;

    let genre_ids = input.genre_ids.map(parse_unique_uuids).transpose()?;
    let existing_genres = repository::genres(&tx, id).await?;
    let existing_ids = existing_genres
        .iter()
        .map(|genre| genre.id)
        .collect::<HashSet<_>>();
    let genre_ids = if let Some(mut requested) = genre_ids {
        let newly_added = requested
            .iter()
            .copied()
            .filter(|id| !existing_ids.contains(id))
            .collect::<Vec<_>>();
        if !newly_added.is_empty() {
            genres::service::ensure_associable(&tx, &newly_added).await?;
        }
        for genre in existing_genres.iter().filter(|genre| !genre.enabled) {
            if !requested.contains(&genre.id) {
                requested.push(genre.id);
            }
        }
        Some(requested)
    } else {
        None
    };
    let updated = repository::persist(&tx, &model, input.version).await?;
    if let Some(ids) = genre_ids {
        repository::replace_genres(&tx, id, &ids).await?;
    }
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在生命周期请求中校验目标状态和版本后执行转换。
pub async fn transition(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<MovieResponse, MovieError> {
    require_positive_i64(expected_version)?;
    let target = parse_target(target)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    // 已处于目标状态时直接返回，令重复请求幂等；真正转换才校验版本并更新状态时间戳。
    if target.matches(&model.status) {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(model.version, expected_version)?;
    // 先约束合法状态转换，再检查发布所需素材；任一失败都不写入状态。
    ensure_transition(&model.status, target)?;
    if target == TargetState::Published {
        validate_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    apply_target_state(
        &mut model.status,
        &mut model.published_at,
        &mut model.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated = repository::persist(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在删除预览请求中统计受影响的内容与媒体。
pub async fn delete_impact(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<DeleteImpactResponse, MovieError> {
    let model = repository::find(db, id).await?;
    let assets = [model.poster_asset_id, model.video_asset_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    Ok(DeleteImpactResponse {
        name: model.name,
        version: model.version,
        season_count: 0,
        episode_count: 0,
        media_count: assets.len() as u64,
    })
}

/// 在电影删除请求中检查状态与版本，并在事务中同步处理关联媒体。
pub async fn delete(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    id: Uuid,
    expected_version: i64,
) -> Result<DeleteResultResponse, MovieError> {
    require_positive_i64(expected_version)?;
    // 数据库提交前只暂存文件；事务失败可恢复，提交成功后才执行不可逆的物理删除。
    let removal = removal::acquire(storage)
        .await
        .map_err(|_| MovieError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_version(model.version, expected_version)?;
    if model.status == "published" {
        return Err(MovieError::Conflict);
    }
    let assets = [model.poster_asset_id, model.video_asset_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids).await?;
    let staged = removal
        .stage("delete-movie", &owned)
        .map_err(|_| MovieError::MediaDelete)?;
    // 汇集内容与资产删除的结果，任一步失败都交由统一收尾回滚事务并恢复暂存文件。
    let database_result: Result<(), MovieError> = async {
        repository::delete(&tx, id, expected_version).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    match removal::finish_delete_transaction(tx, staged, owned.len(), database_result).await {
        Ok(count) => Ok(DeleteResultResponse {
            deleted_media_count: count,
        }),
        Err(removal::FinishDeleteError::Operation(MovieError::Database)) => {
            Err(MovieError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Operation(error)) => Err(error),
        Err(removal::FinishDeleteError::Restore | removal::FinishDeleteError::Commit) => {
            Err(MovieError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Finalize) => Err(MovieError::MediaDeleteFinalization),
    }
}

/// 在读取或写入内容后汇总关联题材和媒体，构造完整响应。
async fn response<C: sea_orm::ConnectionTrait>(
    db: &C,
    model: movie::Model,
) -> Result<MovieResponse, MovieError> {
    let genres = repository::genres(db, model.id).await?;
    let poster = repository::asset(db, model.poster_asset_id).await?;
    let video = repository::asset(db, model.video_asset_id).await?;
    Ok(MovieResponse::new(model, genres, poster, video)?)
}

/// 在发布电影前检查必需字段和媒体是否满足发布条件。
async fn validate_publish<C: sea_orm::ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &movie::Model,
) -> Result<(), MovieError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    // 发布只要求受控存储中存在且可访问的受支持视频；电影海报在当前实现中允许为空。
    let video = repository::asset(db, model.video_asset_id).await?;
    if !is_publishable_asset(storage, video.as_ref(), "video", allowed_video_mime_types) {
        missing.push("video");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(MovieError::Validation(missing))
    }
}
