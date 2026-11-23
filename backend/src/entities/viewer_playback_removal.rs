use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "viewer_playback_removal")]
/// 描述电影、单集或整剧的永久删除截止时间，供离线旧记录冲突判断。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub viewer_user_id: Uuid,
    pub movie_id: Option<Uuid>,
    pub episode_id: Option<Uuid>,
    pub series_id: Option<Uuid>,
    pub removed_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
/// 定义删除墓碑所属用户和三种目标，供冲突查询与内容删除级联使用。
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
    #[sea_orm(
        belongs_to = "super::series::Entity",
        from = "Column::SeriesId",
        to = "super::series::Column::Id",
        on_delete = "Cascade"
    )]
    Series,
}

impl ActiveModelBehavior for ActiveModel {}
