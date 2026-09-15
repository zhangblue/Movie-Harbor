use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
ALTER TABLE media_asset
ADD COLUMN storage_volume integer NOT NULL DEFAULT 0,
ADD CONSTRAINT media_asset_storage_volume_nonnegative CHECK (storage_volume >= 0);
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
ALTER TABLE media_asset
DROP CONSTRAINT media_asset_storage_volume_nonnegative,
DROP COLUMN storage_volume;
"#,
            )
            .await?;
        Ok(())
    }
}
