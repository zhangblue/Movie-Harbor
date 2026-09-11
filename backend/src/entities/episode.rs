use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "episode")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub season_id: Uuid,
    pub number: i32,
    pub name: String,
    pub synopsis: String,
    pub duration_seconds: Option<i32>,
    pub video_asset_id: Option<Uuid>,
    pub status: String,
    pub version: i64,
    pub published_at: Option<DateTimeWithTimeZone>,
    pub archived_at: Option<DateTimeWithTimeZone>,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::season::Entity",
        from = "Column::SeasonId",
        to = "super::season::Column::Id",
        on_delete = "Cascade"
    )]
    Season,
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::VideoAssetId",
        to = "super::media_asset::Column::Id",
        on_delete = "Restrict"
    )]
    VideoAsset,
}

impl Related<super::season::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Season.def()
    }
}
impl Related<super::media_asset::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::VideoAsset.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
