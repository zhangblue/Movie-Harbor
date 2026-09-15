pub use sea_orm_migration::prelude::*;

mod m20260911_000001_core_schema;
mod m20260911_000002_seed_genres;
mod m20260911_000003_public_catalog_indexes;
mod m20260912_000004_drop_episode_synopsis;
mod m20260912_000005_media_ownership;
mod m20260916_000006_media_storage_volume;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260911_000001_core_schema::Migration),
            Box::new(m20260911_000002_seed_genres::Migration),
            Box::new(m20260911_000003_public_catalog_indexes::Migration),
            Box::new(m20260912_000004_drop_episode_synopsis::Migration),
            Box::new(m20260912_000005_media_ownership::Migration),
            Box::new(m20260916_000006_media_storage_volume::Migration),
        ]
    }
}
