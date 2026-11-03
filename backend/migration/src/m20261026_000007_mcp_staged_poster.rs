use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
/// 注册 MCP 暂存海报迁移，供迁移器按版本执行。
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    /// 升级时创建暂存海报记录和过期查询索引。
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
CREATE TABLE mcp_staged_poster (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  principal_hash text NOT NULL,
  asset_id uuid NOT NULL UNIQUE REFERENCES media_asset(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mcp_staged_poster_expiry_idx ON mcp_staged_poster(expires_at, id);
"#,
            )
            .await?;
        Ok(())
    }
    /// 回滚时先拒绝仍有未消费海报的情况，再删除空的暂存记录表。
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Refuse losing the only persistent ownership record of an unconsumed file.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mcp_staged_poster) THEN
    RAISE EXCEPTION 'staged posters must be consumed or cleaned before rollback';
  END IF;
END $$;
DROP TABLE mcp_staged_poster;
"#,
            )
            .await?;
        Ok(())
    }
}
