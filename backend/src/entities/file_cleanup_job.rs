use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "file_cleanup_job")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub media_asset_id: Uuid,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub next_attempt_at: DateTimeWithTimeZone,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::MediaAssetId",
        to = "super::media_asset::Column::Id",
        on_delete = "Restrict"
    )]
    MediaAsset,
}

impl Related<super::media_asset::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MediaAsset.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
