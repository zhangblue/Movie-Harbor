use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_series_cursor")]
/// 描述普通用户每部剧集最近选择的单集，供跨设备进入播放器时定位。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub viewer_user_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub series_id: Uuid,
    pub episode_id: Uuid,
    pub client_updated_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
/// 定义剧集游标所属用户、剧集和单集，供服务校验关系及级联清理。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::viewer_user::Entity",
        from = "Column::ViewerUserId",
        to = "super::viewer_user::Column::Id",
        on_delete = "Cascade"
    )]
    ViewerUser,
    #[sea_orm(
        belongs_to = "super::series::Entity",
        from = "Column::SeriesId",
        to = "super::series::Column::Id",
        on_delete = "Cascade"
    )]
    Series,
    #[sea_orm(
        belongs_to = "super::episode::Entity",
        from = "Column::EpisodeId",
        to = "super::episode::Column::Id",
        on_delete = "Cascade"
    )]
    Episode,
}

impl ActiveModelBehavior for ActiveModel {}
