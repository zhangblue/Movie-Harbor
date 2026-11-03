use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "mcp_staged_poster")]
// 描述MCP 暂存海报数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub token_hash: String,
    pub principal_hash: String,
    pub asset_id: Uuid,
    pub created_at: DateTimeWithTimeZone,
    pub expires_at: DateTimeWithTimeZone,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义MCP 暂存海报的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::AssetId",
        to = "super::media_asset::Column::Id"
    )]
    Asset,
}
impl Related<super::media_asset::Entity> for Entity {
    // 返回MCP 暂存海报到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Asset.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
