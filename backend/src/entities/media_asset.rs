use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "media_asset")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// System-generated relative path beneath the configured media root.
    pub storage_key: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub purpose: String,
    pub checksum_sha256: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::series::Entity")]
    Series,
    #[sea_orm(has_many = "super::episode::Entity")]
    Episode,
    #[sea_orm(has_one = "super::file_cleanup_job::Entity")]
    FileCleanupJob,
}

impl Related<super::series::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Series.def()
    }
}
impl Related<super::episode::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Episode.def()
    }
}
impl Related<super::file_cleanup_job::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FileCleanupJob.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
