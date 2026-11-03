use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "season")]
// 描述剧集季数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub series_id: Uuid,
    pub number: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义剧集季的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::series::Entity",
        from = "Column::SeriesId",
        to = "super::series::Column::Id",
        on_delete = "Cascade"
    )]
    Series,
    #[sea_orm(has_many = "super::episode::Entity")]
    Episode,
}

impl Related<super::series::Entity> for Entity {
    // 返回剧集季到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Series.def()
    }
}
impl Related<super::episode::Entity> for Entity {
    // 返回剧集季到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Episode.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
