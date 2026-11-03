pub use sea_orm_migration::prelude::*;

mod m20260911_000001_core_schema;
mod m20260911_000002_seed_genres;
mod m20260911_000003_public_catalog_indexes;
mod m20260912_000004_drop_episode_synopsis;
mod m20260912_000005_media_ownership;
mod m20261010_000006_private_content_and_viewers;

mod m20261026_000007_mcp_staged_poster;

/// 提供迁移器入口，供数据库升级和回滚时选择有序迁移。
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    /// 在迁移器启动时返回按依赖排序的迁移，保证升级和回滚顺序一致。
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260911_000001_core_schema::Migration),
            Box::new(m20260911_000002_seed_genres::Migration),
            Box::new(m20260911_000003_public_catalog_indexes::Migration),
            Box::new(m20260912_000004_drop_episode_synopsis::Migration),
            Box::new(m20260912_000005_media_ownership::Migration),
            Box::new(m20261010_000006_private_content_and_viewers::Migration),
            Box::new(m20261026_000007_mcp_staged_poster::Migration),
        ]
    }
}
