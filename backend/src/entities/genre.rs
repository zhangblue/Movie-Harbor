use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "genre")]
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
pub enum Relation {
    #[sea_orm(has_many = "super::movie_genre::Entity")]
    MovieGenre,
    #[sea_orm(has_many = "super::series_genre::Entity")]
    SeriesGenre,
}

impl Related<super::movie_genre::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MovieGenre.def()
    }
}
impl Related<super::series_genre::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::SeriesGenre.def()
    }
}
impl Related<super::movie::Entity> for Entity {
    fn to() -> RelationDef {
        super::movie_genre::Relation::Movie.def()
    }
    fn via() -> Option<RelationDef> {
        Some(super::movie_genre::Relation::Genre.def().rev())
    }
}
impl Related<super::series::Entity> for Entity {
    fn to() -> RelationDef {
        super::series_genre::Relation::Series.def()
    }
    fn via() -> Option<RelationDef> {
        Some(super::series_genre::Relation::Genre.def().rev())
    }
}

impl ActiveModelBehavior for ActiveModel {}
