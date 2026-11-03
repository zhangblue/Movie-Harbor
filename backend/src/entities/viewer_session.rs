use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_session")]
// 描述普通用户会话数据库记录，供领域服务读写该实体时使用。
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
// 定义普通用户会话的数据库关联，供实体查询构建关联时使用。
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
    // 返回普通用户会话到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::ViewerUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
