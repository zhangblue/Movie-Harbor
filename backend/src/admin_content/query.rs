use super::dto::{ADMIN_CONTENT_PAGE_SIZE, AdminContentFilter, AdminContentItem, AdminContentPage};
use crate::entities::{media_asset, movie, series};
use chrono::{DateTime, FixedOffset};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseConnection, DbErr, FromQueryResult, IsolationLevel,
    TransactionTrait,
    sea_query::{
        Alias, Asterisk, BinOper, Expr, Func, IntoTableRef, JoinType, Order, Query,
        SelectStatement, UnionType,
    },
};
use uuid::Uuid;

// 构造单种内容的公共投影，供后台列表在数据库内统一筛选与分页。
fn content_branch(
    table: impl IntoTableRef,
    kind: &'static str,
    filter: &AdminContentFilter,
) -> SelectStatement {
    let mut query = Query::select();
    query
        .columns(
            [
                "id",
                "name",
                "status",
                "version",
                "created_at",
                "poster_asset_id",
                "is_private",
            ]
            .map(Alias::new),
        )
        .expr_as(
            Expr::val(kind).cast_as(Alias::new("text")),
            Alias::new("kind"),
        )
        .from(table);
    if let Some(status) = &filter.status {
        query.and_where(Expr::col(Alias::new("status")).eq(status));
    }
    if let Some(is_private) = filter.is_private {
        query.and_where(Expr::col(Alias::new("is_private")).eq(is_private));
    }
    if let Some(pattern) = &filter.name_pattern {
        // 两端都交给 PostgreSQL 转换大小写，并显式保留搜索的字面通配符转义。
        query.and_where(
            Expr::expr(Func::lower(Expr::col(Alias::new("name")))).binary(
                BinOper::Like,
                Expr::expr(Func::lower(Expr::val(pattern))).binary(BinOper::Escape, Expr::val("!")),
            ),
        );
    }
    query
}

// 合并选中的内容类型，供总数和条目查询复用同一组筛选条件。
fn candidates(filter: &AdminContentFilter) -> SelectStatement {
    if filter.kind == "series" {
        return content_branch(series::Entity, "series", filter);
    }
    let mut query = content_branch(movie::Entity, "movie", filter);
    if filter.kind != "movie" {
        query.union(
            UnionType::All,
            content_branch(series::Entity, "series", filter),
        );
    }
    query
}

// 构造带海报及稳定排序的分页查询，只读取当前页需要的字段。
fn items_query(candidates: SelectStatement, offset: u64) -> SelectStatement {
    let content = Alias::new("candidates");
    Query::select()
        .columns(
            [
                "id",
                "kind",
                "name",
                "status",
                "version",
                "created_at",
                "is_private",
            ]
            .map(|column| (content.clone(), Alias::new(column))),
        )
        .expr_as(
            Expr::col((media_asset::Entity, media_asset::Column::StorageKey)),
            Alias::new("poster_storage_key"),
        )
        .from_subquery(candidates, content.clone())
        .join(
            JoinType::LeftJoin,
            media_asset::Entity,
            Expr::col((media_asset::Entity, media_asset::Column::Id))
                .equals((content.clone(), Alias::new("poster_asset_id"))),
        )
        .order_by((content.clone(), Alias::new("created_at")), Order::Desc)
        .order_by((content.clone(), Alias::new("kind")), Order::Asc)
        .order_by((content, Alias::new("id")), Order::Asc)
        .limit(ADMIN_CONTENT_PAGE_SIZE)
        .offset(offset)
        .take()
}

#[derive(Debug, FromQueryResult)]
// 承载管理内容查询行，供映射分页响应时使用。
struct AdminContentRow {
    id: Uuid,
    is_private: bool,
    kind: String,
    name: String,
    status: String,
    version: i64,
    created_at: DateTime<FixedOffset>,
    poster_storage_key: Option<String>,
}

// 读取电影和剧集的统一分页列表，供管理内容路由调用。
pub async fn list(
    db: &DatabaseConnection,
    filter: AdminContentFilter,
) -> Result<AdminContentPage, DbErr> {
    // 总数与当前页必须来自同一 RepeatableRead 快照，避免并发发布导致页码和条目不一致。
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    // 两条语句共享候选集合，筛选、分页和投影均由查询构造器生成。
    let candidates = candidates(&filter);
    let backend = transaction.get_database_backend();
    let total_query = Query::select()
        .expr_as(Expr::col(Asterisk).count(), Alias::new("total"))
        .from_subquery(candidates.clone(), Alias::new("candidates"))
        .take();
    let total_row = transaction
        .query_one(backend.build(&total_query))
        .await?
        .ok_or_else(|| DbErr::Custom("admin content count returned no row".into()))?;
    let total = u64::try_from(total_row.try_get::<i64>("", "total")?)
        .map_err(|_| DbErr::Custom("admin content count was negative".into()))?;
    // 只有分页查询读取海报，可独立验证先后的查询共享同一快照。
    let items_statement = backend.build(&items_query(candidates, filter.offset));
    let rows = AdminContentRow::find_by_statement(items_statement)
        .all(&transaction)
        .await?;
    let items = rows
        .into_iter()
        .map(|row| AdminContentItem {
            id: row.id.to_string(),
            is_private: row.is_private,
            kind: row.kind,
            name: row.name,
            status: row.status,
            version: row.version,
            created_at: row.created_at.to_rfc3339(),
            poster_url: crate::catalog::dto::media_url(row.poster_storage_key, "poster"),
        })
        .collect();
    transaction.commit().await?;
    Ok(AdminContentPage {
        page: filter.page,
        size: ADMIN_CONTENT_PAGE_SIZE,
        total,
        items,
    })
}
