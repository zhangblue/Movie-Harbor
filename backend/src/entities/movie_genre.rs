use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "movie_genre")]
// 描述电影题材关联数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub movie_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub genre_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义电影题材关联的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::movie::Entity",
        from = "Column::MovieId",
        to = "super::movie::Column::Id",
        on_delete = "Cascade"
    )]
    Movie,
    #[sea_orm(
        belongs_to = "super::genre::Entity",
        from = "Column::GenreId",
        to = "super::genre::Column::Id",
        on_delete = "Restrict"
    )]
    Genre,
}

impl Related<super::movie::Entity> for Entity {
    // 返回电影题材关联到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Movie.def()
    }
}
impl Related<super::genre::Entity> for Entity {
    // 返回电影题材关联到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Genre.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
