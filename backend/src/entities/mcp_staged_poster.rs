use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "mcp_staged_poster")]
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
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::AssetId",
        to = "super::media_asset::Column::Id"
    )]
    Asset,
}
impl Related<super::media_asset::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Asset.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
