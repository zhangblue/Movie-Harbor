use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "genre")]
// 描述题材数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub sort_order: i32,
    pub enabled: bool,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义题材的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(has_many = "super::movie_genre::Entity")]
    MovieGenre,
    #[sea_orm(has_many = "super::series_genre::Entity")]
    SeriesGenre,
}

impl Related<super::movie_genre::Entity> for Entity {
    // 返回题材到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::MovieGenre.def()
    }
}
impl Related<super::series_genre::Entity> for Entity {
    // 返回题材到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::SeriesGenre.def()
    }
}
impl Related<super::movie::Entity> for Entity {
    // 返回题材到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        super::movie_genre::Relation::Movie.def()
    }
    // 返回题材到经关联表连接目标实体的路径，供关联查询构建时调用。
    fn via() -> Option<RelationDef> {
        Some(super::movie_genre::Relation::Genre.def().rev())
    }
}
impl Related<super::series::Entity> for Entity {
    // 返回题材到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        super::series_genre::Relation::Series.def()
    }
    // 返回题材到经关联表连接目标实体的路径，供关联查询构建时调用。
    fn via() -> Option<RelationDef> {
        Some(super::series_genre::Relation::Genre.def().rev())
    }
}

impl ActiveModelBehavior for ActiveModel {}
