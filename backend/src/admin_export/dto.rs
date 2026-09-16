use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ContentExport {
    pub exported_at: String,
    pub movies: Vec<ExportMovie>,
    pub series: Vec<ExportSeries>,
}

#[derive(Debug, Serialize)]
pub struct ExportMovie {
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct ExportSeries {
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub episodes: Vec<ExportEpisode>,
}

#[derive(Debug, Serialize)]
pub struct ExportEpisode {
    pub season_number: i32,
    pub episode_number: i32,
    pub name: String,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}
