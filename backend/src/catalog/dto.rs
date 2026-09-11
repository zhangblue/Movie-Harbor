use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const DEFAULT_PAGE_SIZE: u64 = 20;
pub const MAX_PAGE_SIZE: u64 = 100;

#[derive(Debug, Default, Deserialize)]
pub struct CatalogRequest {
    pub kind: Option<String>,
    /// Trimmed substring search. Case folding follows PostgreSQL `lower` under the database
    /// collation; LIKE metacharacters are escaped so all user input is treated literally.
    pub q: Option<String>,
    pub page: Option<u64>,
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogKind {
    All,
    Movie,
    Series,
}

impl CatalogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

#[derive(Debug)]
pub struct CatalogFilter {
    pub kind: CatalogKind,
    pub search_pattern: Option<String>,
    pub page: u64,
    pub size: u64,
    pub offset: u64,
    pub window: u64,
}

impl TryFrom<CatalogRequest> for CatalogFilter {
    type Error = ();

    fn try_from(value: CatalogRequest) -> Result<Self, Self::Error> {
        let kind = match value.kind.as_deref().unwrap_or("all") {
            "all" => CatalogKind::All,
            "movie" => CatalogKind::Movie,
            "series" => CatalogKind::Series,
            _ => return Err(()),
        };
        let page = value.page.unwrap_or(1);
        let size = value.size.unwrap_or(DEFAULT_PAGE_SIZE);
        if page == 0 || size == 0 || size > MAX_PAGE_SIZE {
            return Err(());
        }
        let offset = page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(size))
            .ok_or(())?;
        i64::try_from(offset).map_err(|_| ())?;
        let window = offset.checked_add(size).ok_or(())?;
        i64::try_from(window).map_err(|_| ())?;
        let search_pattern = value
            .q
            .map(|query| query.trim().to_owned())
            .filter(|query| !query.is_empty())
            .map(|query| format!("%{}%", escape_like(&query)));
        Ok(Self {
            kind,
            search_pattern,
            page,
            size,
            offset,
            window,
        })
    }
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '!' | '%' | '_') {
            escaped.push('!');
        }
        escaped.push(character);
    }
    escaped
}

#[derive(Clone, Debug, Serialize)]
pub struct PublicGenre {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogCard {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub published_at: String,
    pub genres: Vec<PublicGenre>,
    pub genre_count: usize,
}

#[derive(Debug, Serialize)]
pub struct CatalogPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<CatalogCard>,
}

#[derive(Debug, Serialize)]
pub struct MovieDetail {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub duration_seconds: Option<i32>,
    pub poster_url: Option<String>,
    pub video_url: Option<String>,
    pub genres: Vec<PublicGenre>,
}

#[derive(Debug, Serialize)]
pub struct SeriesDetail {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub genres: Vec<PublicGenre>,
    pub seasons: Vec<PublicSeason>,
}

#[derive(Debug, Serialize)]
pub struct PublicSeason {
    pub id: String,
    pub number: i32,
    pub episodes: Vec<PublicEpisode>,
}

#[derive(Debug, Serialize)]
pub struct PublicEpisode {
    pub id: String,
    pub number: i32,
    pub name: String,
    pub synopsis: String,
    pub duration_seconds: Option<i32>,
    pub video_url: Option<String>,
}

pub(crate) fn media_url(storage_key: Option<String>, expected_kind: &str) -> Option<String> {
    storage_key
        .filter(|key| controlled_storage_key(key, expected_kind))
        .map(|key| format!("/media/{key}"))
}

fn controlled_storage_key(key: &str, expected_kind: &str) -> bool {
    if key.contains(['\\', '\0']) {
        return false;
    }
    let mut parts = key.split('/');
    let (Some(kind), Some(shard), Some(file), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if kind != expected_kind || !matches!(kind, "poster" | "video") {
        return false;
    }
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    let lowercase_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    let extension_allowed = match kind {
        "poster" => matches!(extension, "jpg" | "png" | "webp"),
        "video" => matches!(extension, "mp4" | "webm" | "ogv"),
        _ => false,
    };
    lowercase_hex(shard, 2)
        && lowercase_hex(stem, 32)
        && stem.starts_with(shard)
        && extension_allowed
}

pub(crate) fn published_at_string(value: DateTime<FixedOffset>) -> String {
    value.to_rfc3339()
}

pub(crate) fn public_genre(id: Uuid, name: String) -> PublicGenre {
    PublicGenre {
        id: id.to_string(),
        name,
    }
}
