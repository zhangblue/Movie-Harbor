use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_playback_progress")]
/// 描述普通用户的电影或单集播放位置，供跨设备同步服务读写。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub viewer_user_id: Uuid,
    pub movie_id: Option<Uuid>,
    pub episode_id: Option<Uuid>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub completed: bool,
    pub client_updated_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
/// 定义播放进度所属用户和可选内容目标，供规范快照关联查询使用。
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::viewer_user::Entity",
        from = "Column::ViewerUserId",
        to = "super::viewer_user::Column::Id",
        on_delete = "Cascade"
    )]
    ViewerUser,
    #[sea_orm(
        belongs_to = "super::movie::Entity",
        from = "Column::MovieId",
        to = "super::movie::Column::Id",
        on_delete = "Cascade"
    )]
    Movie,
    #[sea_orm(
        belongs_to = "super::episode::Entity",
        from = "Column::EpisodeId",
        to = "super::episode::Column::Id",
        on_delete = "Cascade"
    )]
    Episode,
}

impl ActiveModelBehavior for ActiveModel {}
