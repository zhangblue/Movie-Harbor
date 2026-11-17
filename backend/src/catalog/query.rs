use super::dto::{
    CatalogCard, CatalogFilter, CatalogKind, CatalogPage, MovieDetail, PublicEpisode, PublicGenre,
    PublicSeason, SeriesDetail, media_url, public_genre, published_at_string,
};
use crate::entities::{
    episode, genre, media_asset, movie, movie_genre, season, series, series_genre,
};
use chrono::{DateTime, FixedOffset};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseConnection, DbErr, FromQueryResult, IsolationLevel,
    TransactionTrait,
    sea_query::{
        Alias, Asterisk, BinOper, CommonTableExpression, Expr, Func, JoinType, Order, Query,
        SelectStatement, SimpleExpr, UnionType, WithClause,
    },
};
use std::collections::HashMap;
use uuid::Uuid;

// 根据待查类型构造已发布内容的查询基础，供目录卡片、计数和片名名单共享。
fn published_source(kind: CatalogKind, allow_public: bool, allow_private: bool) -> SelectStatement {
    let mut query = Query::select();
    match kind {
        CatalogKind::Movie => query.from(movie::Entity),
        CatalogKind::Series => query.from(series::Entity),
        CatalogKind::All => unreachable!("published_source requires a single content type"),
    };
    query
        .columns(
            [
                "id",
                "name",
                "year",
                "is_private",
                "poster_asset_id",
                "published_at",
            ]
            .map(Alias::new),
        )
        .expr_as(
            Expr::val(kind.as_str()).cast_as(Alias::new("text")),
            Alias::new("kind"),
        )
        .and_where(Expr::col(Alias::new("status")).eq(SimpleExpr::Constant("published".into())))
        .and_where(Expr::col(Alias::new("published_at")).is_not_null());
    match (allow_public, allow_private) {
        (true, true) => {}
        (false, false) => {
            query.and_where(SimpleExpr::Constant(false.into()));
        }
        (public, _) => {
            query.and_where(
                Expr::col(Alias::new("is_private")).eq(SimpleExpr::Constant((!public).into())),
            );
        }
    }
    query
}

// 生成 PostgreSQL 小写匹配和显式转义表达式，以继续使用规范化搜索索引。
fn name_match(column: &'static str, pattern: &str, operator: BinOper) -> SimpleExpr {
    let escaped = SimpleExpr::from(Func::lower(Expr::val(pattern)))
        .binary(BinOper::Escape, SimpleExpr::Constant("!".into()));
    SimpleExpr::from(Func::lower(Expr::col(Alias::new(column)))).binary(operator, escaped)
}

// 为单类目录查询组合名称与简介匹配，分支互斥以防同一作品重复出现。
fn matching_source(source: SelectStatement, pattern: Option<&str>) -> SelectStatement {
    let Some(pattern) = pattern else {
        return source;
    };
    let mut by_name = source.clone();
    by_name.and_where(name_match("name", pattern, BinOper::Like));
    let mut by_synopsis = source;
    by_synopsis
        .and_where(name_match("synopsis", pattern, BinOper::Like))
        .and_where(name_match("name", pattern, BinOper::NotLike));
    by_name.union(UnionType::All, by_synopsis);
    by_name
}

// 合并分类查询，分页时先为每类应用安全窗口，避免给后续媒体连接传入无界集合。
fn catalog_sources(
    kind: CatalogKind,
    allow_public: bool,
    allow_private: bool,
    pattern: Option<&str>,
    window: Option<u64>,
) -> SelectStatement {
    let source = |kind| {
        let query = matching_source(published_source(kind, allow_public, allow_private), pattern);
        let Some(window) = window else { return query };
        Query::select()
            .column(Asterisk)
            .from_subquery(query, Alias::new("matches"))
            .order_by(Alias::new("published_at"), Order::Desc)
            .order_by(Alias::new("id"), Order::Asc)
            .limit(window)
            .to_owned()
    };
    match kind {
        CatalogKind::All => {
            // 聚合前包住两侧窗口，避免第一个分支的 LIMIT 被解释为 UNION 全体的限制。
            let bounded = |kind| {
                let query = source(kind);
                if window.is_none() {
                    query
                } else {
                    Query::select()
                        .column(Asterisk)
                        .from_subquery(query, Alias::new("bounded"))
                        .to_owned()
                }
            };
            let mut query = bounded(CatalogKind::Movie);
            query.union(UnionType::All, bounded(CatalogKind::Series));
            query
        }
        kind => source(kind),
    }
}

/// 构造实际分页语句，集成测试可用同一构建结果验证索引和媒体连接规模。
pub fn catalog_items_query(filter: &CatalogFilter, include_private: bool) -> SelectStatement {
    let candidates = Alias::new("candidates");
    let page = Alias::new("page");
    let media = Alias::new("poster");
    let candidates_cte = CommonTableExpression::new()
        .table_name(candidates.clone())
        .query(catalog_sources(
            filter.kind,
            !filter.private_only,
            include_private,
            filter.search_pattern.as_deref(),
            Some(filter.window),
        ))
        .to_owned();
    let page_query = Query::select()
        .column(Asterisk)
        .from(candidates)
        .order_by(Alias::new("published_at"), Order::Desc)
        .order_by(Alias::new("kind"), Order::Asc)
        .order_by(Alias::new("id"), Order::Asc)
        .offset(filter.offset)
        .limit(filter.size)
        .to_owned();
    // 固化分页结果后才读取海报，以免 PostgreSQL 将媒体连接提前到分页之前。
    let page_cte = CommonTableExpression::new()
        .table_name(page.clone())
        .query(page_query)
        .materialized(true)
        .to_owned();
    let clause = WithClause::new()
        .cte(candidates_cte)
        .cte(page_cte)
        .to_owned();
    Query::select()
        .column((page.clone(), Asterisk))
        .expr_as(
            Expr::col((media.clone(), media_asset::Column::StorageKey)),
            Alias::new("poster_storage_key"),
        )
        .from(page.clone())
        .join_as(
            JoinType::LeftJoin,
            media_asset::Entity,
            media.clone(),
            Expr::col((media, media_asset::Column::Id))
                .equals((page.clone(), Alias::new("poster_asset_id"))),
        )
        .order_by((page.clone(), Alias::new("published_at")), Order::Desc)
        .order_by((page.clone(), Alias::new("kind")), Order::Asc)
        .order_by((page, Alias::new("id")), Order::Asc)
        .with_cte(clause)
        .to_owned()
}

// 生成电影或剧集详情查询，复用发布规则并按需加入电影视频。
fn detail_query(kind: CatalogKind, id: Uuid, include_private: bool) -> SelectStatement {
    let mut content = published_source(kind, true, include_private);
    content
        .column(Alias::new("synopsis"))
        .and_where(Expr::col(Alias::new("id")).eq(id));
    if kind == CatalogKind::Movie {
        content.columns([movie::Column::DurationSeconds, movie::Column::VideoAssetId]);
    }
    let item = Alias::new("item");
    let poster = Alias::new("poster");
    let mut query = Query::select();
    query
        .column((item.clone(), Asterisk))
        .from_subquery(content, item.clone())
        .expr_as(
            Expr::col((poster.clone(), media_asset::Column::StorageKey)),
            Alias::new("poster_storage_key"),
        )
        .join_as(
            JoinType::LeftJoin,
            media_asset::Entity,
            poster.clone(),
            Expr::col((poster, media_asset::Column::Id))
                .equals((item.clone(), Alias::new("poster_asset_id"))),
        );
    if kind == CatalogKind::Movie {
        let video = Alias::new("video");
        query
            .expr_as(
                Expr::col((video.clone(), media_asset::Column::StorageKey)),
                Alias::new("video_storage_key"),
            )
            .join_as(
                JoinType::LeftJoin,
                media_asset::Entity,
                video.clone(),
                Expr::col((video, media_asset::Column::Id))
                    .equals((item, movie::Column::VideoAssetId)),
            );
    }
    query
}

// 已确认可见的父剧集仍在当前事务快照内，按季、集顺序读取有效发布单集。
fn episode_query(id: Uuid) -> SelectStatement {
    Query::select()
        .expr_as(
            Expr::col((season::Entity, season::Column::Id)),
            Alias::new("season_id"),
        )
        .expr_as(
            Expr::col((season::Entity, season::Column::Number)),
            Alias::new("season_number"),
        )
        .columns(
            [
                episode::Column::Id,
                episode::Column::Number,
                episode::Column::Name,
                episode::Column::DurationSeconds,
            ]
            .map(|column| (episode::Entity, column)),
        )
        .expr_as(
            Expr::col((media_asset::Entity, media_asset::Column::StorageKey)),
            Alias::new("video_storage_key"),
        )
        .from(season::Entity)
        .join(
            JoinType::InnerJoin,
            episode::Entity,
            Expr::col((episode::Entity, episode::Column::SeasonId))
                .equals((season::Entity, season::Column::Id)),
        )
        .join(
            JoinType::LeftJoin,
            media_asset::Entity,
            Expr::col((media_asset::Entity, media_asset::Column::Id))
                .equals((episode::Entity, episode::Column::VideoAssetId)),
        )
        .and_where(Expr::col((season::Entity, season::Column::SeriesId)).eq(id))
        .and_where(
            Expr::col((episode::Entity, episode::Column::Status))
                .eq(SimpleExpr::Constant("published".into())),
        )
        .and_where(Expr::col((episode::Entity, episode::Column::PublishedAt)).is_not_null())
        .order_by((season::Entity, season::Column::Number), Order::Asc)
        .order_by((season::Entity, season::Column::Id), Order::Asc)
        .order_by((episode::Entity, episode::Column::Number), Order::Asc)
        .order_by((episode::Entity, episode::Column::Id), Order::Asc)
        .to_owned()
}

#[derive(Debug, FromQueryResult)]
// 承载目录列表查询行，供转换公开卡片时使用。
struct CatalogRow {
    id: Uuid,
    is_private: bool,
    kind: String,
    name: String,
    year: Option<i32>,
    published_at: DateTime<FixedOffset>,
    poster_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
// 承载电影详情查询行，供组装公开电影详情使用。
struct MovieRow {
    id: Uuid,
    is_private: bool,
    name: String,
    synopsis: String,
    year: Option<i32>,
    duration_seconds: Option<i32>,
    poster_storage_key: Option<String>,
    video_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
// 承载剧集详情查询行，供组装公开剧集详情使用。
struct SeriesRow {
    id: Uuid,
    is_private: bool,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_storage_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
// 承载单集查询行，供组装公开剧集详情使用。
struct EpisodeRow {
    season_id: Uuid,
    season_number: i32,
    id: Uuid,
    number: i32,
    name: String,
    duration_seconds: Option<i32>,
    video_storage_key: Option<String>,
}

// 承载题材查询行，供公开内容题材分组使用。
#[derive(FromQueryResult)]
struct GenreRow {
    content_id: Uuid,
    genre_id: Uuid,
    name: String,
}

// 承载名称及所属范围，供助手构建按可见性分组的名称列表。
#[derive(FromQueryResult)]
pub(crate) struct PublishedName {
    pub name: String,
    pub is_private: bool,
}

// 在同一数据库快照中查询指定范围的已发布名称，供助手回答名单或数量问题。
pub(crate) async fn published_names(
    db: &DatabaseConnection,
    kind: CatalogKind,
    allow_public: bool,
    allow_private: bool,
) -> Result<Vec<PublishedName>, DbErr> {
    let candidates = catalog_sources(kind, allow_public, allow_private, None, None);
    let query = Query::select()
        .columns([Alias::new("name"), Alias::new("is_private")])
        .from_subquery(candidates, Alias::new("published"))
        .order_by(Alias::new("is_private"), Order::Asc)
        .order_by(Alias::new("name"), Order::Asc)
        .to_owned();
    query_models(db, &query).await
}

// 在一致性快照中读取公开目录分页，供目录路由调用。
pub async fn list(
    db: &DatabaseConnection,
    filter: CatalogFilter,
    include_private: bool,
) -> Result<CatalogPage, DbErr> {
    // 计数、目录条目与题材必须共享快照，避免页面内的总数、卡片和标签彼此不一致。
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let page = list_on(&transaction, filter, include_private).await?;
    transaction.commit().await?;
    Ok(page)
}

// 按筛选与可见性读取目录分页，供目录事务内查询调用。
async fn list_on<C: ConnectionTrait>(
    db: &C,
    filter: CatalogFilter,
    include_private: bool,
) -> Result<CatalogPage, DbErr> {
    let candidates = catalog_sources(
        filter.kind,
        !filter.private_only,
        include_private,
        filter.search_pattern.as_deref(),
        None,
    );
    let count = Query::select()
        .expr_as(Func::count(Expr::col(Asterisk)), Alias::new("total"))
        .from_subquery(candidates, Alias::new("published"))
        .to_owned();
    let total_row = db
        .query_one(db.get_database_backend().build(&count))
        .await?
        .ok_or_else(|| DbErr::Custom("catalog count returned no row".into()))?;
    let total = u64::try_from(total_row.try_get::<i64>("", "total")?)
        .map_err(|_| DbErr::Custom("catalog count was negative".into()))?;
    let rows =
        query_models::<CatalogRow>(db, &catalog_items_query(&filter, include_private)).await?;
    let references = rows
        .iter()
        .map(|row| (row.kind.as_str(), row.id))
        .collect::<Vec<_>>();
    let mut genres = genres_for(db, &references).await?;
    let items = rows
        .into_iter()
        .map(|row| {
            let all_genres = genres
                .remove(&(row.kind.clone(), row.id))
                .unwrap_or_default();
            let genre_count = all_genres.len();
            CatalogCard {
                id: row.id.to_string(),
                is_private: row.is_private,
                kind: row.kind,
                name: row.name,
                year: row.year,
                poster_url: media_url(row.poster_storage_key, "poster"),
                published_at: published_at_string(row.published_at),
                genres: all_genres.into_iter().take(3).collect(),
                genre_count,
            }
        })
        .collect();
    Ok(CatalogPage {
        page: filter.page,
        size: filter.size,
        total,
        items,
    })
}

// 在一致性快照中读取公开电影详情，供电影详情路由调用。
pub async fn movie_detail(
    db: &DatabaseConnection,
    id: Uuid,
    include_private: bool,
) -> Result<Option<MovieDetail>, DbErr> {
    // 详情主体、媒体 URL 与题材需在同一快照中读取，防止并发归档后返回半旧数据。
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let detail = movie_detail_on(&transaction, id, include_private).await?;
    transaction.commit().await?;
    Ok(detail)
}

// 按可见性读取电影及题材，供电影详情事务内查询调用。
async fn movie_detail_on<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
    include_private: bool,
) -> Result<Option<MovieDetail>, DbErr> {
    let query = detail_query(CatalogKind::Movie, id, include_private);
    let Some(row) = MovieRow::find_by_statement(db.get_database_backend().build(&query))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let mut genres = genres_for(db, &[("movie", id)]).await?;
    Ok(Some(MovieDetail {
        id: row.id.to_string(),
        is_private: row.is_private,
        kind: "movie",
        name: row.name,
        synopsis: row.synopsis,
        year: row.year,
        duration_seconds: row.duration_seconds,
        poster_url: media_url(row.poster_storage_key, "poster"),
        video_url: media_url(row.video_storage_key, "video"),
        genres: genres.remove(&("movie".into(), id)).unwrap_or_default(),
    }))
}

// 在一致性快照中读取公开剧集详情，供剧集详情路由调用。
pub async fn series_detail(
    db: &DatabaseConnection,
    id: Uuid,
    include_private: bool,
) -> Result<Option<SeriesDetail>, DbErr> {
    // 剧集详情、题材和可见单集必须共享快照，保证季集树与父级可见性一致。
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let detail = series_detail_on(&transaction, id, include_private).await?;
    transaction.commit().await?;
    Ok(detail)
}

// 按可见性读取剧集、季和单集，供剧集详情事务内查询调用。
async fn series_detail_on<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
    include_private: bool,
) -> Result<Option<SeriesDetail>, DbErr> {
    let query = detail_query(CatalogKind::Series, id, include_private);
    let Some(row) = SeriesRow::find_by_statement(db.get_database_backend().build(&query))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let mut genres = genres_for(db, &[("series", id)]).await?;
    let episode_rows = query_models::<EpisodeRow>(db, &episode_query(id)).await?;
    let mut seasons = Vec::<PublicSeason>::new();
    for episode in episode_rows {
        if seasons
            .last()
            .is_none_or(|season| season.id != episode.season_id.to_string())
        {
            seasons.push(PublicSeason {
                id: episode.season_id.to_string(),
                number: episode.season_number,
                episodes: Vec::new(),
            });
        }
        seasons.last_mut().unwrap().episodes.push(PublicEpisode {
            id: episode.id.to_string(),
            number: episode.number,
            name: episode.name,
            duration_seconds: episode.duration_seconds,
            video_url: media_url(episode.video_storage_key, "video"),
        });
    }
    Ok(Some(SeriesDetail {
        id: row.id.to_string(),
        is_private: row.is_private,
        kind: "series",
        name: row.name,
        synopsis: row.synopsis,
        year: row.year,
        poster_url: media_url(row.poster_storage_key, "poster"),
        genres: genres.remove(&("series".into(), id)).unwrap_or_default(),
        seasons,
    }))
}

// 执行 SeaQuery 生成的语句并映射投影结果，供目录内部读取使用。
async fn query_models<T: FromQueryResult>(
    db: &impl ConnectionTrait,
    query: &SelectStatement,
) -> Result<Vec<T>, DbErr> {
    T::find_by_statement(db.get_database_backend().build(query))
        .all(db)
        .await
}

// 为当前页或详情批量读取题材，避免逐条卡片查询。
async fn genres_for(
    db: &impl ConnectionTrait,
    references: &[(&str, Uuid)],
) -> Result<HashMap<(String, Uuid), Vec<PublicGenre>>, DbErr> {
    let mut result = HashMap::<(String, Uuid), Vec<PublicGenre>>::new();
    for kind in ["movie", "series"] {
        let ids = references
            .iter()
            .filter(|(content_kind, _)| *content_kind == kind)
            .map(|(_, id)| *id)
            .collect::<Vec<_>>();
        if ids.is_empty() {
            continue;
        }
        let mut query = Query::select();
        match kind {
            "movie" => query
                .expr_as(
                    Expr::col((movie_genre::Entity, movie_genre::Column::MovieId)),
                    Alias::new("content_id"),
                )
                .from(movie_genre::Entity)
                .join(
                    JoinType::InnerJoin,
                    genre::Entity,
                    Expr::col((genre::Entity, genre::Column::Id))
                        .equals((movie_genre::Entity, movie_genre::Column::GenreId)),
                )
                .and_where(
                    Expr::col((movie_genre::Entity, movie_genre::Column::MovieId)).is_in(ids),
                ),
            _ => query
                .expr_as(
                    Expr::col((series_genre::Entity, series_genre::Column::SeriesId)),
                    Alias::new("content_id"),
                )
                .from(series_genre::Entity)
                .join(
                    JoinType::InnerJoin,
                    genre::Entity,
                    Expr::col((genre::Entity, genre::Column::Id))
                        .equals((series_genre::Entity, series_genre::Column::GenreId)),
                )
                .and_where(
                    Expr::col((series_genre::Entity, series_genre::Column::SeriesId)).is_in(ids),
                ),
        };
        query
            .expr_as(
                Expr::col((genre::Entity, genre::Column::Id)),
                Alias::new("genre_id"),
            )
            .column((genre::Entity, genre::Column::Name))
            .order_by((genre::Entity, genre::Column::SortOrder), Order::Asc)
            .order_by((genre::Entity, genre::Column::Id), Order::Asc);
        for row in query_models::<GenreRow>(db, &query).await? {
            result
                .entry((kind.to_owned(), row.content_id))
                .or_default()
                .push(public_genre(row.genre_id, row.name));
        }
    }
    Ok(result)
}
