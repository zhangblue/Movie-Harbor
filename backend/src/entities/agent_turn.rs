use sea_orm::entity::prelude::*;

// 描述助手对话轮次，供个人历史、管理员审阅和模型上下文读写使用。
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_turn")]
pub struct Model {
    // 由 PostgreSQL 递增分配，历史使用它排序并作为游标。
    #[sea_orm(primary_key)]
    pub id: i64,
    // 每轮只归属一种账号，两个外键恰好一个有值，由数据库约束保证。
    pub admin_id: Option<Uuid>,
    pub viewer_id: Option<Uuid>,
    // 浏览器提交的问题在服务端校验与去除首尾空白后保存。
    pub prompt: String,
    // 普通答复原文，或本地片库答复对应的简短模型摘要。
    pub reply: String,
    // 仅站内历史展示使用的完整回复；为空时展示 reply。
    pub local_reply: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

// 定义对话所属账号的两种关联，便于按角色分别筛选和展示账号名称。
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::admin_user::Entity",
        from = "Column::AdminId",
        to = "super::admin_user::Column::Id",
        on_delete = "Cascade"
    )]
    Admin,
    #[sea_orm(
        belongs_to = "super::viewer_user::Entity",
        from = "Column::ViewerId",
        to = "super::viewer_user::Column::Id",
        on_delete = "Cascade"
    )]
    Viewer,
}

// 使用默认的实体写入钩子，由数据库分配对话标识和创建时间。
impl ActiveModelBehavior for ActiveModel {}
