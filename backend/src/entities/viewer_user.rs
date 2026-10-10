use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_user")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub username: String,
    pub normalized_username: String,
    pub password_hash: String,
    pub last_login_at: Option<DateTimeWithTimeZone>,
    pub version: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::viewer_session::Entity")]
    ViewerSession,
}

impl Related<super::viewer_session::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ViewerSession.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
