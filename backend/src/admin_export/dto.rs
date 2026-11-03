use serde::Serialize;

#[derive(Debug, Serialize)]
// 承载全部电影与剧集导出数据，供管理员下载时序列化。
pub struct ContentExport {
    pub exported_at: String,
    pub movies: Vec<ExportMovie>,
    pub series: Vec<ExportSeries>,
}

#[derive(Debug, Serialize)]
// 承载电影导出字段，供内容导出组装结果。
pub struct ExportMovie {
    pub name: String,
    pub is_private: bool,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}

#[derive(Debug, Serialize)]
// 承载剧集及单集导出字段，供内容导出组装结果。
pub struct ExportSeries {
    pub name: String,
    pub is_private: bool,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub episodes: Vec<ExportEpisode>,
}

#[derive(Debug, Serialize)]
// 承载单集导出字段，供剧集导出组装结果。
pub struct ExportEpisode {
    pub season_number: i32,
    pub episode_number: i32,
    pub name: String,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}
