use sea_orm_migration::prelude::*;

// 注册助手对话迁移，供升级时创建独立的账号历史。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    // 每行保存完整的一问一答，并以外键绑定唯一的账号。
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
CREATE TABLE agent_turn (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid REFERENCES admin_user(id) ON DELETE CASCADE,
  viewer_id uuid REFERENCES viewer_user(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  reply text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(admin_id, viewer_id) = 1)
);
CREATE INDEX agent_turn_admin_idx ON agent_turn(admin_id, id DESC) WHERE admin_id IS NOT NULL;
CREATE INDEX agent_turn_viewer_idx ON agent_turn(viewer_id, id DESC) WHERE viewer_id IS NOT NULL;
"#,
            )
            .await?;
        Ok(())
    }

    // 回滚时只允许移除空表，以免已有对话丢失。
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
LOCK TABLE agent_turn IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_turn) THEN
    RAISE EXCEPTION 'agent history must be backed up and cleared before rollback';
  END IF;
END $$;
DROP TABLE agent_turn;
"#,
            )
            .await?;
        Ok(())
    }
}
