use crate::{
    content::{
        ContentRuleError, Patch, TargetState, apply_optional_i32, apply_target_state, apply_text,
        ensure_transition, normalize_required, parse_target, parse_unique_uuids,
        require_positive_i32, require_positive_i64, require_version,
    },
    entities::{episode, season, series},
    genres,
    media::{LocalMediaStorage, is_publishable_asset, removal, staged_poster},
    movies::dto::{DeleteImpactResponse, DeleteResultResponse},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr,
    EntityTrait, IsolationLevel, QueryFilter, QueryOrder, QuerySelect, Set, SqlErr,
    TransactionTrait,
};
use std::collections::HashSet;
use uuid::Uuid;

use super::{
    dto::{
        ChildDeleteImpactResponse, CreateEpisodeRequest, CreateSeriesRequest, EpisodeEnvelope,
        EpisodeResponse, SeasonResponse, SeriesListQuery, SeriesResponse, UpdateEpisodeRequest,
        UpdateSeriesRequest,
    },
    repository,
};

#[derive(Debug)]
/// 剧集领域错误，供服务和路由统一表达校验、冲突及存储失败。
pub enum SeriesError {
    Invalid,
    NotFound,
    Conflict,
    Validation(Vec<&'static str>),
    MediaDelete,
    MediaDeleteFinalization,
    Database,
}

impl From<DbErr> for SeriesError {
    /// 在数据库操作失败时转换为相应剧集领域错误。
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self::Conflict
        } else {
            Self::Database
        }
    }
}

impl From<ContentRuleError> for SeriesError {
    /// 在公共内容规则校验失败时保留无效请求或冲突语义。
    fn from(error: ContentRuleError) -> Self {
        match error {
            ContentRuleError::Invalid => Self::Invalid,
            ContentRuleError::Conflict => Self::Conflict,
        }
    }
}

impl From<genres::service::GenreError> for SeriesError {
    /// 在关联题材失败时映射为剧集字段校验、冲突或数据库错误。
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

impl IntoResponse for SeriesError {
    /// 在路由返回错误时转换为对应的 HTTP 响应。
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"invalid series request"})),
            )
                .into_response(),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"series hierarchy not found"})),
            )
                .into_response(),
            Self::Conflict => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"series state, hierarchy, or version conflict"})),
            )
                .into_response(),
            Self::Validation(fields) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error":"series validation failed", "fields":fields})),
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

/// 创建季命令，供服务层接收父剧集版本及季字段。
pub struct CreateSeasonCommand {
    pub series_id: Uuid,
    pub expected_series_version: i64,
    pub number: i32,
}

/// 修改季命令，供服务层接收层级标识、版本及新字段。
pub struct UpdateSeasonCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub expected_series_version: i64,
    pub number: i32,
}

/// 删除季命令，供服务层接收层级标识与预期版本。
pub struct DeleteSeasonCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub expected_series_version: i64,
}

/// 创建单集命令，供服务层接收层级和单集字段。
pub struct CreateEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub input: CreateEpisodeRequest,
}

/// 修改单集命令，供服务层接收层级、版本及字段补丁。
pub struct UpdateEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub input: UpdateEpisodeRequest,
}

/// 单集状态转换命令，供服务层接收层级、版本和目标状态。
pub struct TransitionEpisodeCommand<'a> {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub expected_episode_version: i64,
    pub target: &'a str,
}

/// 删除单集命令，供服务层接收层级标识与预期版本。
pub struct DeleteEpisodeCommand {
    pub series_id: Uuid,
    pub season_id: Uuid,
    pub episode_id: Uuid,
    pub expected_episode_version: i64,
}

/// 在访问范围变更请求中按版本修改隐私设置并返回更新结果。
pub async fn set_privacy(
    db: &DatabaseConnection,
    id: Uuid,
    expected_version: i64,
    is_private: bool,
) -> Result<SeriesResponse, SeriesError> {
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
) -> Result<SeriesResponse, SeriesError> {
    let name = normalize_required(name)?;
    let model = series::ActiveModel {
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
    input: CreateSeriesRequest,
    principal_hash: &str,
) -> Result<SeriesResponse, SeriesError> {
    let name = normalize_required(input.name).map_err(|_| SeriesError::Validation(vec!["name"]))?;
    let synopsis = normalize_required(
        input
            .synopsis
            .ok_or(SeriesError::Validation(vec!["synopsis"]))?,
    )
    .map_err(|_| SeriesError::Validation(vec!["synopsis"]))?;
    let year = input
        .year
        .filter(|year| (1..=9999).contains(year))
        .ok_or(SeriesError::Validation(vec!["year"]))?;
    let genre_ids = parse_unique_uuids(input.genre_ids.unwrap_or_default())
        .map_err(|_| SeriesError::Validation(vec!["genres"]))?;
    if genre_ids.is_empty() {
        return Err(SeriesError::Validation(vec!["genres"]));
    }
    let token = input
        .staged_poster_token
        .filter(|token| !token.trim().is_empty())
        .ok_or(SeriesError::Validation(vec!["poster"]))?;
    // 与电影创建保持一致：先锁暂存海报，再锁题材，内容/独占归属/关系与 token 删除同事务提交。
    let tx = db.begin().await?;
    let poster =
        staged_poster::lock_for_consumption(&tx, &token, principal_hash, Utc::now().fixed_offset())
            .await
            // 令牌不存在、过期或不属于当前主体均提示海报无效，存储故障则保留内部错误语义。
            .map_err(|error| match error {
                staged_poster::StagedPosterError::NotFound => {
                    SeriesError::Validation(vec!["poster"])
                }
                staged_poster::StagedPosterError::Media(_) => SeriesError::Database,
            })?;
    genres::service::ensure_associable(&tx, &genre_ids).await?;
    // 既有数据库触发器随内容 INSERT 原子建立 media_asset_ownership，禁止跨内容共享海报。
    let model = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        is_private: Set(input.is_private),
        synopsis: Set(synopsis),
        year: Set(Some(year)),
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
pub async fn detail<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<SeriesResponse, SeriesError> {
    response(db, repository::find(db, id).await?).await
}

/// 在列表请求中读取符合筛选条件的内容并组装响应。
pub async fn list(
    db: &DatabaseConnection,
    query: SeriesListQuery,
) -> Result<Vec<SeriesResponse>, SeriesError> {
    let mut select = series::Entity::find().order_by_desc(series::Column::CreatedAt);
    if let Some(status) = query.status {
        if !matches!(status.as_str(), "draft" | "published" | "archived") {
            return Err(SeriesError::Invalid);
        }
        select = select.filter(series::Column::Status.eq(status));
    }
    if let Some(name) = query.name {
        let name = name.trim();
        if !name.is_empty() {
            select = select.filter(series::Column::Name.contains(name));
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
    input: UpdateSeriesRequest,
) -> Result<SeriesResponse, SeriesError> {
    require_positive_i64(input.version)?;
    // 剧集自身字段仅草稿可编辑；子级写操作另行锁定父级并递增其版本。
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    require_version(model.version, input.version)?;
    if model.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_text(&mut model.name, input.name, true)?;
    apply_text(&mut model.synopsis, input.synopsis, false)?;
    apply_optional_i32(&mut model.year, input.year, false)?;

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
    let updated = repository::persist_series(&tx, &model, input.version).await?;
    if let Some(ids) = genre_ids {
        repository::replace_genres(&tx, id, &ids).await?;
    }
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在创建季请求中校验父剧集和版本并建立季。
pub async fn create_season(
    db: &DatabaseConnection,
    command: CreateSeasonCommand,
) -> Result<SeriesResponse, SeriesError> {
    create_season_with_policy(db, command, false).await
}

/// 在 MCP 创建季时使用对应策略校验并建立季。
pub async fn create_season_mcp(
    db: &DatabaseConnection,
    command: CreateSeasonCommand,
) -> Result<SeriesResponse, SeriesError> {
    create_season_with_policy(db, command, true).await
}

/// 在创建季的入口选定策略后执行共用的层级写入。
async fn create_season_with_policy(
    db: &DatabaseConnection,
    command: CreateSeasonCommand,
    reject_archived_parent: bool,
) -> Result<SeriesResponse, SeriesError> {
    let CreateSeasonCommand {
        series_id,
        expected_series_version: expected_version,
        number,
    } = command;
    require_positive_i64(expected_version)?;
    require_positive_i32(number)?;
    // 此处不编辑剧集自身字段，只以父版本串行化下级创建，因此已发布剧集仍可新增季；单集创建会显式设为草稿。
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
    if reject_archived_parent && model.status == "archived" {
        return Err(SeriesError::Conflict);
    }
    season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series_id),
        number: Set(number),
    }
    .insert(&tx)
    .await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在修改季请求中检查父剧集版本及已发布单集约束后更新。
pub async fn update_season(
    db: &DatabaseConnection,
    command: UpdateSeasonCommand,
) -> Result<SeriesResponse, SeriesError> {
    let UpdateSeasonCommand {
        series_id,
        season_id,
        expected_series_version: expected_version,
        number,
    } = command;
    require_positive_i64(expected_version)?;
    require_positive_i32(number)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
    let current = repository::season_locked(&tx, series_id, season_id).await?;
    if current.number == number {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    // 季内已有已发布单集时，季号不可改动，防止改变已公开单集的层级位置。
    if repository::episodes_locked(&tx, season_id)
        .await?
        .iter()
        .any(|episode| episode.status == "published")
    {
        return Err(SeriesError::Conflict);
    }
    let mut active: season::ActiveModel = current.into();
    active.number = Set(number);
    active.update(&tx).await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在删除季请求中检查层级与状态并同步清理其媒体。
pub async fn delete_season(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    command: DeleteSeasonCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteSeasonCommand {
        series_id,
        season_id,
        expected_series_version: expected_version,
    } = command;
    require_positive_i64(expected_version)?;
    // 依次锁定父剧集、季和全部单集；先暂存关联视频，数据库失败时可恢复文件。
    let removal = removal::acquire(storage)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, expected_version)?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episodes = repository::episodes_locked(&tx, season_id).await?;
    // 季内已有已发布单集时不可删除，避免级联删除已公开内容。
    if episodes.iter().any(|episode| episode.status == "published") {
        return Err(SeriesError::Conflict);
    }
    let assets = episodes
        .into_iter()
        .filter_map(|episode| episode.video_asset_id)
        .collect::<HashSet<_>>();
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids).await?;
    let staged = removal
        .stage("delete-season", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    // 将季级联删除、整剧版本推进和资产删除作为同一结果交给收尾，失败时恢复暂存文件。
    let database_result: Result<(), SeriesError> = async {
        season::Entity::delete_by_id(season_id).exec(&tx).await?;
        repository::bump_series(&tx, &model).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
}

/// 在 MCP 创建单集时使用对应策略校验并建立草稿。
pub async fn create_episode_mcp(
    db: &DatabaseConnection,
    command: CreateEpisodeCommand,
) -> Result<SeriesResponse, SeriesError> {
    let input = &command.input;
    let mut fields = Vec::new();
    if input.version <= 0 {
        fields.push("version");
    }
    if input.number <= 0 {
        fields.push("number");
    }
    if input.name.trim().is_empty() {
        fields.push("name");
    }
    if input.duration_seconds.is_none_or(|duration| duration <= 0) {
        fields.push("duration_seconds");
    }
    if !fields.is_empty() {
        return Err(SeriesError::Validation(fields));
    }
    create_episode_with_policy(db, command, true).await
}

/// 在创建单集请求中校验层级和版本后建立草稿。
pub async fn create_episode(
    db: &DatabaseConnection,
    command: CreateEpisodeCommand,
) -> Result<SeriesResponse, SeriesError> {
    create_episode_with_policy(db, command, false).await
}

/// 在创建单集的入口选定策略后执行共用的层级写入。
async fn create_episode_with_policy(
    db: &DatabaseConnection,
    command: CreateEpisodeCommand,
    reject_archived_parent: bool,
) -> Result<SeriesResponse, SeriesError> {
    let CreateEpisodeCommand {
        series_id,
        season_id,
        input,
    } = command;
    require_positive_i64(input.version)?;
    require_positive_i32(input.number)?;
    if let Some(duration) = input.duration_seconds {
        require_positive_i32(duration)?;
    }
    let name = normalize_required(input.name)?;
    // 新单集按 series -> season 加锁并递增父版本，使返回的剧集快照不会漏掉并发新增。
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, series_id).await?;
    require_version(model.version, input.version)?;
    if reject_archived_parent && model.status == "archived" {
        return Err(SeriesError::Conflict);
    }
    repository::season_locked(&tx, series_id, season_id).await?;
    episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season_id),
        number: Set(input.number),
        name: Set(name),
        duration_seconds: Set(input.duration_seconds),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&tx)
    .await?;
    let updated = repository::bump_series(&tx, &model).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在单集详情请求中验证所属层级并组装响应。
pub async fn episode_detail(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<EpisodeEnvelope, SeriesError> {
    let series = repository::find(db, series_id).await?;
    let season = season::Entity::find()
        .filter(season::Column::Id.eq(season_id))
        .filter(season::Column::SeriesId.eq(series_id))
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let episode = episode::Entity::find()
        .filter(episode::Column::Id.eq(episode_id))
        .filter(episode::Column::SeasonId.eq(season.id))
        .one(db)
        .await?
        .ok_or(SeriesError::NotFound)?;
    episode_envelope(db, series.version, episode).await
}

/// 在编辑单集请求中检查草稿状态及版本后保存。
pub async fn update_episode(
    db: &DatabaseConnection,
    command: UpdateEpisodeCommand,
) -> Result<EpisodeEnvelope, SeriesError> {
    let UpdateEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        input,
    } = command;
    require_positive_i64(input.version)?;
    // 先按全局顺序锁住祖先和单集；单集版本校验成功后，同时递增父剧集版本。
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_version(episode.version, input.version)?;
    if episode.status != "draft" {
        return Err(SeriesError::Conflict);
    }
    apply_required_number(&mut episode.number, input.number)?;
    apply_text(&mut episode.name, input.name, true)?;
    apply_optional_i32(&mut episode.duration_seconds, input.duration_seconds, true)?;
    let updated_episode = repository::persist_episode(&tx, &episode, input.version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在剧集状态转换请求中检查生命周期与版本并保存结果。
pub async fn transition_series(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    id: Uuid,
    expected_version: i64,
    target: &str,
) -> Result<SeriesResponse, SeriesError> {
    require_positive_i64(expected_version)?;
    let target = parse_target(target)?;
    let tx = db.begin().await?;
    let mut model = repository::find_locked(&tx, id).await?;
    // 重复目标状态直接成功；实际转换交给公共状态机维护 published_at 与 archived_at。
    if target.matches(&model.status) {
        let result = response(&tx, model).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(model.version, expected_version)?;
    // 先通过状态机校验转换，发布所需字段不完整时也不会保存新状态。
    ensure_transition(&model.status, target)?;
    if target == TargetState::Published {
        validate_series_publish(&tx, storage, allowed_video_mime_types, &model).await?;
    }
    apply_target_state(
        &mut model.status,
        &mut model.published_at,
        &mut model.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated = repository::persist_series(&tx, &model, expected_version).await?;
    let result = response(&tx, updated).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在单集状态转换请求中检查层级、生命周期与版本并保存结果。
pub async fn transition_episode(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    command: TransitionEpisodeCommand<'_>,
) -> Result<EpisodeEnvelope, SeriesError> {
    let TransitionEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        expected_episode_version: expected_version,
        target,
    } = command;
    require_positive_i64(expected_version)?;
    let target = parse_target(target)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let mut episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    // 单集状态独立于父剧集；重复目标状态直接成功，公开查询则同时要求父剧集和单集都已发布。
    if target.matches(&episode.status) {
        let result = episode_envelope(&tx, series.version, episode).await?;
        tx.commit().await?;
        return Ok(result);
    }
    require_version(episode.version, expected_version)?;
    // 单集状态独立校验；发布素材缺失时保持原状态和父版本。
    ensure_transition(&episode.status, target)?;
    if target == TargetState::Published {
        validate_episode_publish(&tx, storage, allowed_video_mime_types, &episode).await?;
    }
    apply_target_state(
        &mut episode.status,
        &mut episode.published_at,
        &mut episode.archived_at,
        target,
        Utc::now().fixed_offset(),
    );
    let updated_episode = repository::persist_episode(&tx, &episode, expected_version).await?;
    let updated_series = repository::bump_series(&tx, &series).await?;
    let result = episode_envelope(&tx, updated_series.version, updated_episode).await?;
    tx.commit().await?;
    Ok(result)
}

/// 在删除单集时按层级及版本约束执行删除和媒体清理。
pub async fn delete_episode(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    command: DeleteEpisodeCommand,
) -> Result<DeleteResultResponse, SeriesError> {
    let DeleteEpisodeCommand {
        series_id,
        season_id,
        episode_id,
        expected_episode_version: expected_version,
    } = command;
    require_positive_i64(expected_version)?;
    // 先按层级锁定目标，再暂存独占视频；提交前操作失败时恢复文件。
    // 提交结果未知时保留隔离副本和清单，由启动恢复根据数据库引用判断。
    let removal = removal::acquire(storage)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let series = repository::find_locked(&tx, series_id).await?;
    repository::season_locked(&tx, series_id, season_id).await?;
    let episode = repository::episode_locked(&tx, season_id, episode_id).await?;
    require_version(episode.version, expected_version)?;
    if episode.status == "published" {
        return Err(SeriesError::Conflict);
    }
    let asset_ids = episode.video_asset_id.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids).await?;
    let staged = removal
        .stage("delete-episode", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    // 删除单集后同步推进整剧版本并删除资产；任何写入失败都由统一收尾回滚和恢复文件。
    let database_result: Result<(), SeriesError> = async {
        repository::delete_episode(&tx, episode_id, expected_version).await?;
        repository::bump_series(&tx, &series).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
}

/// 在删除整剧时检查生命周期与版本并清理子级媒体。
pub async fn delete_series(
    db: &DatabaseConnection,
    storage: &LocalMediaStorage,
    id: Uuid,
    expected_version: i64,
) -> Result<DeleteResultResponse, SeriesError> {
    require_positive_i64(expected_version)?;
    // 整剧删除先锁定剧集及全部下级，再暂存海报和视频；提交前操作失败时恢复文件。
    // 提交结果未知时保留隔离副本和清单，由启动恢复根据数据库引用判断。
    let removal = removal::acquire(storage)
        .await
        .map_err(|_| SeriesError::MediaDelete)?;
    let tx = db.begin().await?;
    let model = repository::find_locked(&tx, id).await?;
    require_version(model.version, expected_version)?;
    if model.status == "published" {
        return Err(SeriesError::Conflict);
    }

    // 所有层级写操作统一按 series -> season -> episode 加锁，删除和状态转换共享顺序以避免死锁。
    // 级联前按 UUID 顺序锁定同层子项，避免删除与单集状态转换交错。
    let seasons = season::Entity::find()
        .filter(season::Column::SeriesId.eq(id))
        .order_by_asc(season::Column::Id)
        .lock_exclusive()
        .all(&tx)
        .await?;
    let mut assets = model.poster_asset_id.into_iter().collect::<HashSet<_>>();
    for season in seasons {
        let episodes = repository::episodes_locked(&tx, season.id).await?;
        assets.extend(
            episodes
                .into_iter()
                .filter_map(|episode| episode.video_asset_id),
        );
    }
    let asset_ids = assets.into_iter().collect::<Vec<_>>();
    let owned = removal::load_owned_media(&tx, &asset_ids).await?;
    let staged = removal
        .stage("delete-series", &owned)
        .map_err(|_| SeriesError::MediaDelete)?;
    // 整剧层级与媒体记录在同一事务删除，结果交给收尾决定提交清理或回滚恢复。
    let database_result: Result<(), SeriesError> = async {
        repository::delete_series(&tx, id, expected_version).await?;
        removal::delete_media_assets(&tx, &asset_ids).await?;
        Ok(())
    }
    .await;
    finish_delete_transaction(tx, staged, owned.len(), database_result).await
}

/// 在删除操作完成数据库写入后协调提交、文件恢复和最终清理。
async fn finish_delete_transaction(
    tx: sea_orm::DatabaseTransaction,
    staged: removal::StagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), SeriesError>,
) -> Result<DeleteResultResponse, SeriesError> {
    // 提交前操作失败时恢复暂存文件；提交结果未知则保留清单，成功后才物理删除。
    match removal::finish_delete_transaction(tx, staged, deleted_media_count, database_result).await
    {
        Ok(count) => Ok(DeleteResultResponse {
            deleted_media_count: count,
        }),
        Err(removal::FinishDeleteError::Operation(SeriesError::Database)) => {
            Err(SeriesError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Operation(error)) => Err(error),
        Err(removal::FinishDeleteError::Restore | removal::FinishDeleteError::Commit) => {
            Err(SeriesError::MediaDelete)
        }
        Err(removal::FinishDeleteError::Finalize) => Err(SeriesError::MediaDeleteFinalization),
    }
}

/// 在删除预览请求中统计受影响的内容与媒体。
pub async fn delete_impact(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<DeleteImpactResponse, SeriesError> {
    let model = repository::find(db, id).await?;
    let seasons = repository::seasons(db, id).await?;
    let mut episode_count = 0_u64;
    let mut assets = HashSet::new();
    if let Some(asset_id) = model.poster_asset_id {
        assets.insert(asset_id);
    }
    for season in &seasons {
        for episode in repository::episodes(db, season.id).await? {
            episode_count += 1;
            if let Some(asset_id) = episode.video_asset_id {
                assets.insert(asset_id);
            }
        }
    }
    Ok(DeleteImpactResponse {
        name: model.name,
        version: model.version,
        season_count: seasons.len() as u64,
        episode_count,
        media_count: assets.len() as u64,
    })
}

/// 在删除季前统计其单集与媒体影响。
pub async fn season_delete_impact(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
) -> Result<ChildDeleteImpactResponse, SeriesError> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let parent = repository::find(&tx, series_id).await?;
    let selected = season::Entity::find_by_id(season_id)
        .filter(season::Column::SeriesId.eq(series_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let episodes = repository::episodes(&tx, season_id).await?;
    let mut assets = HashSet::new();
    for asset_id in episodes.iter().filter_map(|episode| episode.video_asset_id) {
        assets.insert(asset_id);
    }
    let result = ChildDeleteImpactResponse {
        display_name: format!("第 {} 季", selected.number),
        version: parent.version,
        season_count: 1,
        episode_count: episodes.len() as u64,
        media_count: assets.len() as u64,
    };
    tx.commit().await?;
    Ok(result)
}

/// 在删除单集前统计其媒体影响。
pub async fn episode_delete_impact(
    db: &DatabaseConnection,
    series_id: Uuid,
    season_id: Uuid,
    episode_id: Uuid,
) -> Result<ChildDeleteImpactResponse, SeriesError> {
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    repository::find(&tx, series_id).await?;
    season::Entity::find_by_id(season_id)
        .filter(season::Column::SeriesId.eq(series_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let selected = episode::Entity::find_by_id(episode_id)
        .filter(episode::Column::SeasonId.eq(season_id))
        .one(&tx)
        .await?
        .ok_or(SeriesError::NotFound)?;
    let result = ChildDeleteImpactResponse {
        display_name: selected.name,
        version: selected.version,
        season_count: 0,
        episode_count: 1,
        media_count: u64::from(selected.video_asset_id.is_some()),
    };
    tx.commit().await?;
    Ok(result)
}

/// 在读取或写入内容后汇总关联题材和媒体，构造完整响应。
async fn response<C: ConnectionTrait>(
    db: &C,
    model: series::Model,
) -> Result<SeriesResponse, SeriesError> {
    let genres = repository::genres(db, model.id).await?;
    let poster = repository::asset(db, model.poster_asset_id).await?;
    let mut season_responses = Vec::new();
    for season in repository::seasons(db, model.id).await? {
        let mut episode_responses = Vec::new();
        for episode in repository::episodes(db, season.id).await? {
            let video = repository::asset(db, episode.video_asset_id).await?;
            episode_responses.push(EpisodeResponse::new(episode, video)?);
        }
        season_responses.push(SeasonResponse::new(season, episode_responses));
    }
    Ok(SeriesResponse::new(
        model,
        genres,
        poster,
        season_responses,
    )?)
}

/// 在单集读取或写入后汇总单集与父剧集版本，构造响应。
async fn episode_envelope<C: ConnectionTrait>(
    db: &C,
    series_version: i64,
    episode: episode::Model,
) -> Result<EpisodeEnvelope, SeriesError> {
    let video = repository::asset(db, episode.video_asset_id).await?;
    Ok(EpisodeEnvelope {
        series_version,
        episode: EpisodeResponse::new(episode, video)?,
    })
}

/// 在发布剧集前检查名称，以及至少一集已发布且拥有受支持、可访问的视频；海报可为空。
async fn validate_series_publish<C: ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &series::Model,
) -> Result<(), SeriesError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    // 发布剧集要求至少一集已发布且拥有受控、可访问的受支持视频；剧集海报允许为空。
    let mut publishable_episode = false;
    for season in repository::seasons(db, model.id).await? {
        for episode in repository::episodes(db, season.id).await? {
            if episode.status != "published" {
                continue;
            }
            let video = repository::asset(db, episode.video_asset_id).await?;
            if is_publishable_asset(storage, video.as_ref(), "video", allowed_video_mime_types) {
                publishable_episode = true;
                break;
            }
        }
        if publishable_episode {
            break;
        }
    }
    if !publishable_episode {
        missing.push("episodes");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(SeriesError::Validation(missing))
    }
}

/// 在发布单集前检查必需字段与视频是否满足发布条件。
async fn validate_episode_publish<C: ConnectionTrait>(
    db: &C,
    storage: &LocalMediaStorage,
    allowed_video_mime_types: &[String],
    model: &episode::Model,
) -> Result<(), SeriesError> {
    let mut missing = Vec::new();
    if model.name.trim().is_empty() {
        missing.push("name");
    }
    // 单集发布独立校验名称与受控、可访问的受支持视频；父级状态不在此处随之转换。
    let video = repository::asset(db, model.video_asset_id).await?;
    if !is_publishable_asset(storage, video.as_ref(), "video", allowed_video_mime_types) {
        missing.push("video");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(SeriesError::Validation(missing))
    }
}

/// 在修改单集序号时应用补丁；未提供字段则保留原值，拒绝显式清空和非正整数。
fn apply_required_number(current: &mut i32, patch: Patch<i32>) -> Result<(), SeriesError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Value(value) => {
            require_positive_i32(value)?;
            *current = value;
            Ok(())
        }
        Patch::Null => Err(SeriesError::Invalid),
    }
}
