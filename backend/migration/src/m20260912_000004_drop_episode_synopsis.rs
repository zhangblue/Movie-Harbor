use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
/// 注册单集简介字段移除迁移，供迁移器按版本执行。
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    /// 升级时删除不再使用的单集简介及其数据。
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE episode DROP COLUMN synopsis")
            .await?;
        Ok(())
    }

    /// 回滚时重建带空默认值的简介列，原内容无法恢复。
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE episode ADD COLUMN synopsis text NOT NULL DEFAULT ''")
            .await?;
        Ok(())
    }
}
