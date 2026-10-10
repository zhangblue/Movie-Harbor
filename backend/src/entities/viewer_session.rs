use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_session")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub viewer_user_id: Uuid,
    pub token_hash: String,
    pub csrf_token_hash: String,
    pub expires_at: DateTimeWithTimeZone,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::viewer_user::Entity",
        from = "Column::ViewerUserId",
        to = "super::viewer_user::Column::Id",
        on_delete = "Cascade"
    )]
    ViewerUser,
}

impl Related<super::viewer_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ViewerUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
