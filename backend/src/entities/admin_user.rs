use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "admin_user")]
// 描述管理员账号数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub password_hash: String,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义管理员账号的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(has_many = "super::admin_session::Entity")]
    AdminSession,
}

impl Related<super::admin_session::Entity> for Entity {
    // 返回管理员账号到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::AdminSession.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
