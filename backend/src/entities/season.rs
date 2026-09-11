use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "season")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub series_id: Uuid,
    pub number: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
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
    fn to() -> RelationDef {
        Relation::Series.def()
    }
}
impl Related<super::episode::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Episode.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
