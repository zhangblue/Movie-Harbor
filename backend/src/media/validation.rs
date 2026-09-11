use super::MediaError;
use std::{
    collections::BTreeSet,
    path::{Component, Path},
};

const SNIFF_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Poster,
    Video,
}

impl MediaKind {
    pub(crate) fn directory(self) -> &'static str {
        match self {
            Self::Poster => "poster",
            Self::Video => "video",
        }
    }

    pub(crate) fn purpose(self) -> &'static str {
        self.directory()
    }
}

#[derive(Clone, Debug)]
pub struct UploadPolicy {
    max_bytes: u64,
    allowed_video_mime_types: BTreeSet<String>,
}

impl UploadPolicy {
    pub fn new<I, S>(max_bytes: u64, allowed_video_mime_types: I) -> Result<Self, MediaError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        const SUPPORTED: [&str; 3] = ["video/mp4", "video/webm", "video/ogg"];
        if max_bytes == 0 {
            return Err(MediaError::TooLarge);
        }
        let allowed = allowed_video_mime_types
            .into_iter()
            .map(|mime| mime.as_ref().trim().to_owned())
            .collect::<BTreeSet<_>>();
        if allowed.is_empty()
            || allowed
                .iter()
                .any(|mime| !SUPPORTED.contains(&mime.as_str()))
        {
            return Err(MediaError::UnsupportedType);
        }
        Ok(Self {
            max_bytes,
            allowed_video_mime_types: allowed,
        })
    }

    pub(crate) fn max_bytes(&self) -> u64 {
        self.max_bytes
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ExpectedFormat {
    pub extension: &'static str,
    pub mime_type: &'static str,
}

pub(crate) fn validate_metadata(
    kind: MediaKind,
    original_name: &str,
    declared_mime: &str,
    policy: &UploadPolicy,
) -> Result<ExpectedFormat, MediaError> {
    if original_name.is_empty()
        || original_name.contains(['/', '\\', '\0'])
        || !matches!(
            Path::new(original_name)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [Component::Normal(_)]
        )
    {
        return Err(MediaError::InvalidFileName);
    }
    let extension = Path::new(original_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(MediaError::UnsupportedType)?;
    let expected = match (kind, extension.as_str()) {
        (MediaKind::Poster, "jpg" | "jpeg") => ExpectedFormat {
            extension: "jpg",
            mime_type: "image/jpeg",
        },
        (MediaKind::Poster, "png") => ExpectedFormat {
            extension: "png",
            mime_type: "image/png",
        },
        (MediaKind::Poster, "webp") => ExpectedFormat {
            extension: "webp",
            mime_type: "image/webp",
        },
        (MediaKind::Video, "mp4") => ExpectedFormat {
            extension: "mp4",
            mime_type: "video/mp4",
        },
        (MediaKind::Video, "webm") => ExpectedFormat {
            extension: "webm",
            mime_type: "video/webm",
        },
        (MediaKind::Video, "ogv" | "ogg") => ExpectedFormat {
            extension: "ogv",
            mime_type: "video/ogg",
        },
        _ => return Err(MediaError::UnsupportedType),
    };
    if declared_mime != expected.mime_type
        || (kind == MediaKind::Video && !policy.allowed_video_mime_types.contains(declared_mime))
    {
        return Err(MediaError::UnsupportedType);
    }
    Ok(expected)
}

pub(crate) fn validate_content(format: ExpectedFormat, prefix: &[u8]) -> Result<(), MediaError> {
    if prefix.is_empty() {
        return Err(MediaError::Empty);
    }
    let matches = match format.mime_type {
        "image/jpeg" => prefix.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => prefix.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => {
            prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WEBP"
        }
        "video/mp4" => {
            prefix.len() >= 12
                && &prefix[4..8] == b"ftyp"
                && u32::from_be_bytes(prefix[..4].try_into().unwrap()) >= 12
        }
        "video/webm" => {
            prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
                && prefix
                    .windows(4)
                    .any(|bytes| bytes.eq_ignore_ascii_case(b"webm"))
        }
        "video/ogg" => prefix.starts_with(b"OggS"),
        _ => false,
    };
    matches.then_some(()).ok_or(MediaError::ContentMismatch)
}

pub(crate) fn retain_sniff_prefix(prefix: &mut Vec<u8>, chunk: &[u8]) {
    let remaining = SNIFF_BYTES.saturating_sub(prefix.len());
    prefix.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
}
