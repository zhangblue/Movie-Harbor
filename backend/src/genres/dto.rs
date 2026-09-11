use crate::entities::genre;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct CreateGenreRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateGenreRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ReorderGenresRequest {
    pub items: Vec<ReorderGenre>,
}

#[derive(Deserialize)]
pub struct ReorderGenre {
    pub id: String,
    pub sort_order: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct GenreResponse {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    pub enabled: bool,
}

impl From<genre::Model> for GenreResponse {
    fn from(model: genre::Model) -> Self {
        Self {
            id: model.id.to_string(),
            name: model.name,
            sort_order: model.sort_order,
            enabled: model.enabled,
        }
    }
}
