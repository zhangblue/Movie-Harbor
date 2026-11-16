use sea_orm_migration::prelude::*;

// 将网站内部的片库答案与下轮可交给模型的上下文分开。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    // 将完整片库答复存入单独字段，原字段继续容纳可用于模型上下文的文字。
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE agent_turn ADD COLUMN local_reply text")
            .await?;
        Ok(())
    }

    // 存在本地答复时拒绝移除字段，以保留完整的历史。
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
LOCK TABLE agent_turn IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_turn WHERE local_reply IS NOT NULL) THEN
    RAISE EXCEPTION 'local agent history must be backed up and cleared before rollback';
  END IF;
END $$;
ALTER TABLE agent_turn DROP COLUMN local_reply;
"#,
            )
            .await?;
        Ok(())
    }
}
