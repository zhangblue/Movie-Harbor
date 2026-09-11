pub use sea_orm_migration::prelude::*;

mod m20260911_000001_core_schema;
mod m20260911_000002_seed_genres;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260911_000001_core_schema::Migration),
            Box::new(m20260911_000002_seed_genres::Migration),
        ]
    }
}
