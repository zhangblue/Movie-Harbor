use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_user")]
// 描述普通用户账号数据库记录，供领域服务读写该实体时使用。
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
// 定义普通用户账号的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(has_many = "super::viewer_session::Entity")]
    ViewerSession,
}

impl Related<super::viewer_session::Entity> for Entity {
    // 返回普通用户账号到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::ViewerSession.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
