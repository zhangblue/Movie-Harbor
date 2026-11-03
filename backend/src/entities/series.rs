use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "series")]
// 描述剧集数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub poster_asset_id: Option<Uuid>,
    pub status: String,
    pub is_private: bool,
    pub version: i64,
    pub published_at: Option<DateTimeWithTimeZone>,
    pub archived_at: Option<DateTimeWithTimeZone>,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义剧集的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::media_asset::Entity",
        from = "Column::PosterAssetId",
        to = "super::media_asset::Column::Id",
        on_delete = "Restrict"
    )]
    PosterAsset,
    #[sea_orm(has_many = "super::season::Entity")]
    Season,
    #[sea_orm(has_many = "super::series_genre::Entity")]
    SeriesGenre,
}

impl Related<super::media_asset::Entity> for Entity {
    // 返回剧集到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::PosterAsset.def()
    }
}
impl Related<super::season::Entity> for Entity {
    // 返回剧集到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Season.def()
    }
}
impl Related<super::series_genre::Entity> for Entity {
    // 返回剧集到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::SeriesGenre.def()
    }
}
impl Related<super::genre::Entity> for Entity {
    // 返回剧集到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        super::series_genre::Relation::Genre.def()
    }
    // 返回剧集到经关联表连接目标实体的路径，供关联查询构建时调用。
    fn via() -> Option<RelationDef> {
        Some(super::series_genre::Relation::Series.def().rev())
    }
}

impl ActiveModelBehavior for ActiveModel {}
