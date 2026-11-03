use crate::entities::genre;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
// 承载新题材名称，供创建题材路由解析请求。
pub struct CreateGenreRequest {
    pub name: String,
}

#[derive(Deserialize)]
// 承载题材新名称，供重命名路由解析请求。
pub struct UpdateGenreRequest {
    pub name: String,
}

#[derive(Deserialize)]
// 承载题材排序列表，供排序路由解析请求。
pub struct ReorderGenresRequest {
    pub items: Vec<ReorderGenre>,
}

#[derive(Deserialize)]
// 承载单个题材标识与排序值，供排序请求校验使用。
pub struct ReorderGenre {
    pub id: String,
    pub sort_order: i32,
}

#[derive(Clone, Debug, Serialize)]
// 承载题材管理响应字段，供题材路由返回。
pub struct GenreResponse {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    pub enabled: bool,
}

impl From<genre::Model> for GenreResponse {
    // 将题材实体转换为响应，供题材路由返回结果时调用。
    fn from(model: genre::Model) -> Self {
        Self {
            id: model.id.to_string(),
            name: model.name,
            sort_order: model.sort_order,
            enabled: model.enabled,
        }
    }
}
