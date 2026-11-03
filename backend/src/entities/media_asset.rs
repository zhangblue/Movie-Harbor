use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "media_asset")]
// 描述媒体资产数据库记录，供领域服务读写该实体时使用。
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// 系统生成的受控存储键，表示配置媒体根目录下的相对路径。
    pub storage_key: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub purpose: String,
    pub checksum_sha256: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
// 定义媒体资产的数据库关联，供实体查询构建关联时使用。
pub enum Relation {
    #[sea_orm(has_many = "super::series::Entity")]
    Series,
    #[sea_orm(has_many = "super::episode::Entity")]
    Episode,
}

impl Related<super::series::Entity> for Entity {
    // 返回媒体资产到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Series.def()
    }
}
impl Related<super::episode::Entity> for Entity {
    // 返回媒体资产到目标实体的关联定义，供关联查询构建时调用。
    fn to() -> RelationDef {
        Relation::Episode.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
