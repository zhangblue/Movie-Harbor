use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "movie")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub duration_seconds: Option<i32>,
    pub poster_asset_id: Option<Uuid>,
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
        belongs_to = "super::media_asset::Entity",
        from = "Column::PosterAssetId",
        to = "super::media_asset::Column::Id",
        on_delete = "Restrict"
    )]
    PosterAsset,
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::VideoAssetId",
        to = "super::media_asset::Column::Id",
        on_delete = "Restrict"
    )]
    VideoAsset,
    #[sea_orm(has_many = "super::movie_genre::Entity")]
    MovieGenre,
}

impl Related<super::movie_genre::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MovieGenre.def()
    }
}
impl Related<super::genre::Entity> for Entity {
    fn to() -> RelationDef {
        super::movie_genre::Relation::Genre.def()
    }
    fn via() -> Option<RelationDef> {
        Some(super::movie_genre::Relation::Movie.def().rev())
    }
}

impl ActiveModelBehavior for ActiveModel {}
