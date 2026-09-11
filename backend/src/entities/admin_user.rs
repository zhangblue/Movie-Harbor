use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "admin_user")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub password_hash: String,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::admin_session::Entity")]
    AdminSession,
}

impl Related<super::admin_session::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AdminSession.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
