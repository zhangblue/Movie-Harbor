use crate::{
    auth::{self, AuthState},
    entities::{episode, media_asset, movie, season, series},
    viewer_auth,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use sea_orm::{
    ConnectionTrait, FromQueryResult,
    sea_query::{self, Alias, Condition, Expr, Iden, JoinType, Query, SelectStatement, UnionType},
};

/// 标记归属索引的表和字段，用于同时确认索引与实际媒体槽位。
#[derive(Iden)]
enum MediaAssetOwnership {
    Table,
    AssetId,
    OwnerKind,
    OwnerId,
    Slot,
}

/// 从查询结果读取发布和私密标记，供代理访问判定。
#[derive(FromQueryResult)]
struct OwnerAccess {
    published: bool,
    is_private: bool,
}

/// 为所有归属分支构造相同的资产键、用途和槽位条件。
fn asset_ownership(key: &str, purpose: &str) -> SelectStatement {
    Query::select()
        .from(media_asset::Entity)
        .join(
            JoinType::InnerJoin,
            MediaAssetOwnership::Table,
            Expr::col((MediaAssetOwnership::Table, MediaAssetOwnership::AssetId))
                .equals((media_asset::Entity, media_asset::Column::Id)),
        )
        .and_where(Expr::col((media_asset::Entity, media_asset::Column::StorageKey)).eq(key))
        .and_where(Expr::col((media_asset::Entity, media_asset::Column::Purpose)).eq(purpose))
        .and_where(Expr::col((MediaAssetOwnership::Table, MediaAssetOwnership::Slot)).eq(purpose))
        .to_owned()
}

/// 将索引的归属类型与实际内容主键绑定，供各媒体分支验证。
fn owner_condition(kind: &str, id: impl sea_orm::sea_query::IntoColumnRef) -> Condition {
    Condition::all()
        .add(Expr::col((MediaAssetOwnership::Table, MediaAssetOwnership::OwnerKind)).eq(kind))
        .add(Expr::col((MediaAssetOwnership::Table, MediaAssetOwnership::OwnerId)).equals(id))
}

/// 将索引的槽位与内容中的真实资产引用绑定，防止陈旧索引放行。
fn slot_condition(slot: &str, asset: impl sea_orm::sea_query::IntoColumnRef) -> Condition {
    Condition::all()
        .add(Expr::col((MediaAssetOwnership::Table, MediaAssetOwnership::Slot)).eq(slot))
        .add(Expr::col(asset).equals((media_asset::Entity, media_asset::Column::Id)))
}

/// 为授权查询构造有效发布状态条件，供电影、剧集和单集复用。
fn published(
    status: impl sea_orm::sea_query::IntoColumnRef,
    published_at: impl sea_orm::sea_query::IntoColumnRef,
) -> sea_orm::sea_query::SimpleExpr {
    Expr::col(status)
        .eq("published")
        .and(Expr::col(published_at).is_not_null())
}

/// 将三个归属类型合并到单条查询，确保槽位和内容状态来自同一数据库快照。
fn owner_query(key: &str, purpose: &str) -> SelectStatement {
    let series_published = published(
        (series::Entity, series::Column::Status),
        (series::Entity, series::Column::PublishedAt),
    );
    let mut movie_owner = asset_ownership(key, purpose);
    movie_owner
        .expr_as(
            published(
                (movie::Entity, movie::Column::Status),
                (movie::Entity, movie::Column::PublishedAt),
            ),
            Alias::new("published"),
        )
        .column((movie::Entity, movie::Column::IsPrivate))
        .join(
            JoinType::InnerJoin,
            movie::Entity,
            owner_condition("movie", (movie::Entity, movie::Column::Id)).add(
                Condition::any()
                    .add(slot_condition(
                        "poster",
                        (movie::Entity, movie::Column::PosterAssetId),
                    ))
                    .add(slot_condition(
                        "video",
                        (movie::Entity, movie::Column::VideoAssetId),
                    )),
            ),
        );

    let mut series_owner = asset_ownership(key, purpose);
    series_owner
        .expr_as(series_published.clone(), Alias::new("published"))
        .column((series::Entity, series::Column::IsPrivate))
        .join(
            JoinType::InnerJoin,
            series::Entity,
            owner_condition("series", (series::Entity, series::Column::Id)).add(slot_condition(
                "poster",
                (series::Entity, series::Column::PosterAssetId),
            )),
        );

    let mut episode_owner = asset_ownership(key, purpose);
    episode_owner
        .expr_as(
            series_published.and(published(
                (episode::Entity, episode::Column::Status),
                (episode::Entity, episode::Column::PublishedAt),
            )),
            Alias::new("published"),
        )
        .column((series::Entity, series::Column::IsPrivate))
        .join(
            JoinType::InnerJoin,
            episode::Entity,
            owner_condition("episode", (episode::Entity, episode::Column::Id)).add(slot_condition(
                "video",
                (episode::Entity, episode::Column::VideoAssetId),
            )),
        )
        .join(
            JoinType::InnerJoin,
            season::Entity,
            Expr::col((season::Entity, season::Column::Id))
                .equals((episode::Entity, episode::Column::SeasonId)),
        )
        .join(
            JoinType::InnerJoin,
            series::Entity,
            Expr::col((series::Entity, series::Column::Id))
                .equals((season::Entity, season::Column::SeriesId)),
        );

    movie_owner
        .union(UnionType::All, series_owner)
        .union(UnionType::All, episode_owner);
    movie_owner
}

/// 在代理请求媒体授权时返回允许或隐藏资源的结果，并禁止共享缓存。
pub(super) async fn authorize(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // 授权查询异常也按拒绝处理，避免数据库或请求头错误暴露媒体存在性。
    let allowed = is_allowed(&state, &headers).await.unwrap_or(false);
    (
        if allowed {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
        [(header::CACHE_CONTROL, "private, no-store")],
    )
}

/// 在媒体授权请求中验证可信代理、归属、发布状态及访问会话。
async fn is_allowed(state: &AuthState, headers: &HeaderMap) -> Option<bool> {
    let token = single_header(headers, "x-movie-harbor-proxy-token")?;
    if !state.trust_proxy_headers
        || !auth::csrf::matches(token, state.trusted_proxy_secret_digest.as_deref()?)
    {
        return None;
    }
    let uri = single_header(headers, "x-forwarded-uri")?;
    // 系统生成的 URL 是 ASCII 且无需解码，不归一化不可信请求路径。
    if !uri.is_ascii() || uri.contains('#') {
        return None;
    }
    let path = uri.split_once('?').map_or(uri, |(path, _)| path);
    let key = path.strip_prefix("/media/")?;
    let (purpose, _) = key.split_once('/')?;
    super::path::controlled_media_url(key, purpose)?;
    let statement = state
        .db
        .get_database_backend()
        .build(&owner_query(key, purpose));
    let rows = OwnerAccess::find_by_statement(statement)
        .all(&state.db)
        .await
        .ok()?;
    if rows.len() != 1 {
        // 归属缺失或不唯一均无法证明槽位有效，不能继续授权。
        return None;
    }
    let owner = &rows[0];
    // 先检查管理员会话；有效管理员可预览各状态的媒体。
    if auth::session::authenticate(&state.db, headers)
        .await
        .is_ok()
    {
        return Some(true);
    }
    if !owner.published {
        return Some(false);
    }
    if !owner.is_private {
        return Some(true);
    }
    // 仅已发布的私密媒体需要普通用户会话；未登录或认证失败不得放行。
    Some(
        viewer_auth::session::authenticate_optional(&state.db, headers)
            .await
            .ok()?
            .is_some(),
    )
}

/// 在检查代理请求头时只接受单个有效字符串值，歧义时拒绝。
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}
