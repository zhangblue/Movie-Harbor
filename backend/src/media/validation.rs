use super::MediaError;
use image::{ImageFormat, ImageReader, Limits};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Component, Path},
};

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
        const SUPPORTED: [&str; 2] = ["video/mp4", "video/webm"];
        if max_bytes == 0 || max_bytes > i64::MAX as u64 {
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
        _ => return Err(MediaError::UnsupportedType),
    };
    if declared_mime != expected.mime_type
        || (kind == MediaKind::Video && !policy.allowed_video_mime_types.contains(declared_mime))
    {
        return Err(MediaError::UnsupportedType);
    }
    Ok(expected)
}

pub(crate) fn validate_content(
    format: ExpectedFormat,
    file: &mut File,
    byte_size: u64,
) -> Result<(), MediaError> {
    if byte_size == 0 {
        return Err(MediaError::Empty);
    }
    file.seek(SeekFrom::Start(0))?;
    let matches = match format.mime_type {
        "image/jpeg" => validate_jpeg(file, byte_size) && decode_image(file, ImageFormat::Jpeg),
        "image/png" => validate_png(file, byte_size) && decode_image(file, ImageFormat::Png),
        "image/webp" => validate_webp(file, byte_size) && decode_image(file, ImageFormat::WebP),
        "video/mp4" => validate_mp4(file, byte_size),
        "video/webm" => validate_webm(file, byte_size),
        _ => false,
    };
    matches.then_some(()).ok_or(MediaError::ContentMismatch)
}

const MAX_DIMENSION: u32 = 16_384;
const MAX_PARSE_DEPTH: usize = 8;
const MAX_IMAGE_ALLOCATION_BYTES: u64 = 64 * 1024 * 1024;

fn decode_image(file: &File, format: ImageFormat) -> bool {
    let Ok(mut cloned) = file.try_clone() else {
        return false;
    };
    if cloned.seek(SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut reader = ImageReader::with_format(BufReader::new(cloned), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_ALLOCATION_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .is_ok_and(|image| image.width() > 0 && image.height() > 0)
}

fn read_exact<R: Read>(reader: &mut R, bytes: &mut [u8]) -> bool {
    reader.read_exact(bytes).is_ok()
}

fn validate_png(file: &mut File, byte_size: u64) -> bool {
    let mut signature = [0; 8];
    if byte_size < 45 || !read_exact(file, &mut signature) || signature != *b"\x89PNG\r\n\x1a\n" {
        return false;
    }
    let mut position = 8_u64;
    let mut saw_header = false;
    let mut saw_data = false;
    while position + 12 <= byte_size {
        let mut header = [0; 8];
        if !read_exact(file, &mut header) {
            return false;
        }
        let length = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        if position
            .checked_add(12)
            .and_then(|value| value.checked_add(length))
            .is_none_or(|end| end > byte_size)
        {
            return false;
        }
        let kind: [u8; 4] = header[4..].try_into().unwrap();
        let mut crc = png_crc_update(0xffff_ffff, &kind);
        let mut first = [0_u8; 13];
        let mut remaining = length;
        let mut offset = 0_usize;
        let mut buffer = [0_u8; 8192];
        while remaining > 0 {
            let amount = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
            if !read_exact(file, &mut buffer[..amount]) {
                return false;
            }
            let capture = amount.min(first.len().saturating_sub(offset));
            first[offset..offset + capture].copy_from_slice(&buffer[..capture]);
            offset += capture;
            crc = png_crc_update(crc, &buffer[..amount]);
            remaining -= amount as u64;
        }
        let mut stored_crc = [0; 4];
        if !read_exact(file, &mut stored_crc) || (!crc) != u32::from_be_bytes(stored_crc) {
            return false;
        }
        position += 12 + length;
        match &kind {
            b"IHDR" => {
                if saw_header || position != 33 || length != 13 {
                    return false;
                }
                let width = u32::from_be_bytes(first[..4].try_into().unwrap());
                let height = u32::from_be_bytes(first[4..8].try_into().unwrap());
                if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
                    return false;
                }
                saw_header = true;
            }
            b"IDAT" => saw_data = true,
            b"IEND" => return saw_header && saw_data && length == 0 && position == byte_size,
            _ => {}
        }
    }
    false
}

fn png_crc_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn validate_jpeg(file: &mut File, byte_size: u64) -> bool {
    let mut soi = [0; 2];
    if byte_size < 12 || !read_exact(file, &mut soi) || soi != [0xff, 0xd8] {
        return false;
    }
    let mut saw_frame = false;
    let mut saw_scan = false;
    let mut marker = match next_jpeg_marker(file) {
        Some(marker) => marker,
        None => return false,
    };
    loop {
        if marker == 0xd9 {
            return saw_frame && saw_scan && file.stream_position().ok() == Some(byte_size);
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            marker = match next_jpeg_marker(file) {
                Some(next) => next,
                None => return false,
            };
            continue;
        }
        let mut length_bytes = [0; 2];
        if !read_exact(file, &mut length_bytes) {
            return false;
        }
        let length = usize::from(u16::from_be_bytes(length_bytes));
        if length < 2 {
            return false;
        }
        let payload_len = length - 2;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if payload_len < 6 {
                return false;
            }
            let mut frame = [0; 6];
            if !read_exact(file, &mut frame) {
                return false;
            }
            let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
            let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
            if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
                return false;
            }
            if file
                .seek(SeekFrom::Current((payload_len - 6) as i64))
                .is_err()
            {
                return false;
            }
            saw_frame = true;
        } else if file.seek(SeekFrom::Current(payload_len as i64)).is_err() {
            return false;
        }
        if marker == 0xda {
            saw_scan = true;
            marker = match next_entropy_marker(file) {
                Some(next) => next,
                None => return false,
            };
        } else {
            marker = match next_jpeg_marker(file) {
                Some(next) => next,
                None => return false,
            };
        }
    }
}

fn next_jpeg_marker<R: Read>(reader: &mut R) -> Option<u8> {
    let mut byte = [0];
    reader.read_exact(&mut byte).ok()?;
    if byte[0] != 0xff {
        return None;
    }
    loop {
        reader.read_exact(&mut byte).ok()?;
        if byte[0] != 0xff {
            return (byte[0] != 0).then_some(byte[0]);
        }
    }
}

fn next_entropy_marker<R: Read>(reader: &mut R) -> Option<u8> {
    let mut byte = [0];
    loop {
        reader.read_exact(&mut byte).ok()?;
        if byte[0] != 0xff {
            continue;
        }
        loop {
            reader.read_exact(&mut byte).ok()?;
            match byte[0] {
                0x00 => break,
                0xff => continue,
                0xd0..=0xd7 => break,
                marker => return Some(marker),
            }
        }
    }
}

fn validate_webp(file: &mut File, byte_size: u64) -> bool {
    let mut header = [0; 12];
    if byte_size < 30
        || !read_exact(file, &mut header)
        || &header[..4] != b"RIFF"
        || &header[8..] != b"WEBP"
    {
        return false;
    }
    if u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8 != byte_size {
        return false;
    }
    let mut position = 12_u64;
    let mut image_data = false;
    while position + 8 <= byte_size {
        let mut chunk = [0; 8];
        if !read_exact(file, &mut chunk) {
            return false;
        }
        let length = u64::from(u32::from_le_bytes(chunk[4..].try_into().unwrap()));
        let padded = length + (length & 1);
        if position + 8 + padded > byte_size {
            return false;
        }
        let mut prefix = [0; 10];
        let amount = usize::try_from(length.min(10)).unwrap();
        if !read_exact(file, &mut prefix[..amount]) {
            return false;
        }
        if file
            .seek(SeekFrom::Current((padded - amount as u64) as i64))
            .is_err()
        {
            return false;
        }
        match &chunk[..4] {
            b"VP8X" if length == 10 => {
                let width = 1 + u32::from_le_bytes([prefix[4], prefix[5], prefix[6], 0]);
                let height = 1 + u32::from_le_bytes([prefix[7], prefix[8], prefix[9], 0]);
                if width > MAX_DIMENSION || height > MAX_DIMENSION {
                    return false;
                }
            }
            b"VP8L" if length > 5 && prefix[0] == 0x2f => {
                let packed = u32::from_le_bytes(prefix[1..5].try_into().unwrap());
                if packed >> 29 != 0 {
                    return false;
                }
                image_data = true;
            }
            b"VP8 " if length > 10 && prefix[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u16::from_le_bytes([prefix[6], prefix[7]]) & 0x3fff;
                let height = u16::from_le_bytes([prefix[8], prefix[9]]) & 0x3fff;
                if width == 0 || height == 0 {
                    return false;
                }
                image_data = true;
            }
            _ => {}
        }
        position += 8 + padded;
    }
    image_data && position == byte_size
}

const MAX_MP4_TABLE_ENTRIES: usize = 1_000_000;
const MAX_CONTAINER_ELEMENTS: usize = 100_000;

#[derive(Default)]
struct Mp4State {
    ftyp: bool,
    mdat_ranges: Vec<(u64, u64)>,
    tracks: Vec<Mp4Track>,
    boxes_seen: usize,
}

#[derive(Default)]
struct Mp4Track {
    video_handler: bool,
    nal_length_bytes: Option<usize>,
    sample_description: Option<(u64, u64)>,
    sample_sizes: Mp4SampleSizes,
    chunk_offsets: Vec<u64>,
    sample_to_chunks: Vec<(u32, u32, u32)>,
    timed_sample_count: Option<u64>,
}

#[derive(Default)]
enum Mp4SampleSizes {
    #[default]
    Missing,
    Fixed {
        size: u32,
        count: usize,
    },
    Variable(Vec<u32>),
}

impl Mp4SampleSizes {
    fn len(&self) -> usize {
        match self {
            Self::Missing => 0,
            Self::Fixed { count, .. } => *count,
            Self::Variable(sizes) => sizes.len(),
        }
    }

    fn get(&self, index: usize) -> Option<u32> {
        match self {
            Self::Missing => None,
            Self::Fixed { size, count } => (index < *count).then_some(*size),
            Self::Variable(sizes) => sizes.get(index).copied(),
        }
    }
}

fn validate_mp4(file: &mut File, byte_size: u64) -> bool {
    let mut state = Mp4State::default();
    parse_mp4_boxes(file, 0, byte_size, 0, &mut state)
        && state.ftyp
        && !state.mdat_ranges.is_empty()
        && state
            .tracks
            .iter()
            .any(|track| validate_mp4_track(file, track, &state.mdat_ranges))
}

fn parse_mp4_boxes(
    file: &mut File,
    start: u64,
    end: u64,
    depth: usize,
    state: &mut Mp4State,
) -> bool {
    if depth > MAX_PARSE_DEPTH || file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut position = start;
    while position < end {
        state.boxes_seen += 1;
        if state.boxes_seen > MAX_CONTAINER_ELEMENTS {
            return false;
        }
        let mut header = [0; 8];
        if end - position < 8 || !read_exact(file, &mut header) {
            return false;
        }
        let mut size = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        let mut header_size = 8_u64;
        if size == 1 {
            let mut extended = [0; 8];
            if !read_exact(file, &mut extended) {
                return false;
            }
            size = u64::from_be_bytes(extended);
            header_size = 16;
        }
        if size < header_size || position.checked_add(size).is_none_or(|value| value > end) {
            return false;
        }
        let payload_start = position + header_size;
        let payload_end = position + size;
        match &header[4..8] {
            b"ftyp" => {
                let payload_len = payload_end - payload_start;
                if !(8..=256).contains(&payload_len) || !(payload_len - 8).is_multiple_of(4) {
                    return false;
                }
                let mut brands = vec![0; payload_len as usize];
                if !read_exact(file, &mut brands) {
                    return false;
                }
                state.ftyp = brands.get(..4).is_some_and(supported_mp4_brand)
                    || (8..brands.len()).step_by(4).any(|offset| {
                        brands
                            .get(offset..offset + 4)
                            .is_some_and(supported_mp4_brand)
                    });
            }
            b"mdat" if payload_end > payload_start => {
                state.mdat_ranges.push((payload_start, payload_end));
            }
            b"trak" => {
                let mut track = Mp4Track::default();
                if !parse_mp4_track_boxes(
                    file,
                    payload_start,
                    payload_end,
                    depth + 1,
                    &mut track,
                    &mut state.boxes_seen,
                ) {
                    return false;
                }
                if track.video_handler {
                    let Some((start, end)) = track.sample_description else {
                        return false;
                    };
                    if !parse_mp4_stsd(file, start, end, &mut track) {
                        return false;
                    }
                }
                state.tracks.push(track);
            }
            b"moov" if !parse_mp4_boxes(file, payload_start, payload_end, depth + 1, state) => {
                return false;
            }
            _ => {}
        }
        position = payload_end;
        if file.seek(SeekFrom::Start(position)).is_err() {
            return false;
        }
    }
    position == end
}

fn parse_mp4_track_boxes(
    file: &mut File,
    start: u64,
    end: u64,
    depth: usize,
    track: &mut Mp4Track,
    boxes_seen: &mut usize,
) -> bool {
    if depth > MAX_PARSE_DEPTH || file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut position = start;
    while position < end {
        *boxes_seen += 1;
        if *boxes_seen > MAX_CONTAINER_ELEMENTS {
            return false;
        }
        let mut header = [0; 8];
        if end - position < 8 || !read_exact(file, &mut header) {
            return false;
        }
        let size = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        if size < 8 || position.checked_add(size).is_none_or(|next| next > end) {
            return false;
        }
        let payload_start = position + 8;
        let payload_end = position + size;
        let valid = match &header[4..8] {
            b"mdia" | b"minf" | b"stbl" => parse_mp4_track_boxes(
                file,
                payload_start,
                payload_end,
                depth + 1,
                track,
                boxes_seen,
            ),
            b"hdlr" => parse_mp4_handler(file, payload_start, payload_end, track),
            b"stsd" => track
                .sample_description
                .replace((payload_start, payload_end))
                .is_none(),
            b"stts" => parse_mp4_stts(file, payload_start, payload_end, track),
            b"stsc" => parse_mp4_stsc(file, payload_start, payload_end, track),
            b"stsz" => parse_mp4_stsz(file, payload_start, payload_end, track),
            b"stco" => parse_mp4_chunk_offsets(file, payload_start, payload_end, track, false),
            b"co64" => parse_mp4_chunk_offsets(file, payload_start, payload_end, track, true),
            _ => true,
        };
        if !valid {
            return false;
        }
        position = payload_end;
        if file.seek(SeekFrom::Start(position)).is_err() {
            return false;
        }
    }
    position == end
}

fn parse_mp4_handler(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    let mut payload = [0; 12];
    if end - start < payload.len() as u64 || !read_exact(file, &mut payload) {
        return false;
    }
    track.video_handler = &payload[8..12] == b"vide";
    true
}

fn parse_mp4_stsd(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    let mut header = [0; 8];
    if end - start < header.len() as u64
        || file.seek(SeekFrom::Start(start)).is_err()
        || !read_exact(file, &mut header)
    {
        return false;
    }
    let count = u32::from_be_bytes(header[4..8].try_into().unwrap());
    let entry_start = match start.checked_add(8) {
        Some(value) => value,
        None => return false,
    };
    let mut entry = [0; 86];
    if end - entry_start < entry.len() as u64 || !read_exact(file, &mut entry) {
        return false;
    }
    let entry_size = u64::from(u32::from_be_bytes(entry[..4].try_into().unwrap()));
    let entry_end = match entry_start.checked_add(entry_size) {
        Some(value) if value <= end => value,
        _ => return false,
    };
    if count != 1 || entry_size < 86 {
        return false;
    }
    let width = u32::from(u16::from_be_bytes([entry[32], entry[33]]));
    let height = u32::from(u16::from_be_bytes([entry[34], entry[35]]));
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return false;
    }
    track.nal_length_bytes =
        validate_mp4_codec_configuration(file, &entry[4..8], entry_start + 86, entry_end);
    track.nal_length_bytes.is_some()
}

fn read_mp4_entry_count(file: &mut File, start: u64, end: u64, width: u64) -> Option<usize> {
    let mut header = [0; 8];
    (end - start >= 8 && read_exact(file, &mut header)).then_some(())?;
    let count = usize::try_from(u32::from_be_bytes(header[4..8].try_into().ok()?)).ok()?;
    (count <= MAX_MP4_TABLE_ENTRIES
        && 8_u64.checked_add((count as u64).checked_mul(width)?)? <= end - start)
        .then_some(count)
}

fn parse_mp4_stts(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    let Some(count) = read_mp4_entry_count(file, start, end, 8) else {
        return false;
    };
    let mut total = 0_u64;
    for _ in 0..count {
        let mut entry = [0; 8];
        if !read_exact(file, &mut entry) {
            return false;
        }
        let samples = u64::from(u32::from_be_bytes(entry[..4].try_into().unwrap()));
        let duration = u32::from_be_bytes(entry[4..].try_into().unwrap());
        if samples == 0 || duration == 0 {
            return false;
        }
        let Some(next) = total.checked_add(samples) else {
            return false;
        };
        total = next;
    }
    track.timed_sample_count = Some(total);
    true
}

fn parse_mp4_stsc(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    let Some(count) = read_mp4_entry_count(file, start, end, 12) else {
        return false;
    };
    track.sample_to_chunks.clear();
    for _ in 0..count {
        let mut entry = [0; 12];
        if !read_exact(file, &mut entry) {
            return false;
        }
        track.sample_to_chunks.push((
            u32::from_be_bytes(entry[..4].try_into().unwrap()),
            u32::from_be_bytes(entry[4..8].try_into().unwrap()),
            u32::from_be_bytes(entry[8..].try_into().unwrap()),
        ));
    }
    true
}

fn parse_mp4_stsz(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    let mut header = [0; 12];
    if end - start < 12 || !read_exact(file, &mut header) {
        return false;
    }
    let default_size = u32::from_be_bytes(header[4..8].try_into().unwrap());
    let Ok(count) = usize::try_from(u32::from_be_bytes(header[8..12].try_into().unwrap())) else {
        return false;
    };
    if count == 0 || count > MAX_MP4_TABLE_ENTRIES {
        return false;
    }
    if default_size != 0 {
        track.sample_sizes = Mp4SampleSizes::Fixed {
            size: default_size,
            count,
        };
        return true;
    }
    if 12_u64
        .checked_add((count as u64).saturating_mul(4))
        .is_none_or(|required| required > end - start)
    {
        return false;
    }
    let mut sizes = Vec::with_capacity(count);
    for _ in 0..count {
        let mut size = [0; 4];
        if !read_exact(file, &mut size) {
            return false;
        }
        sizes.push(u32::from_be_bytes(size));
    }
    track.sample_sizes = Mp4SampleSizes::Variable(sizes);
    true
}

fn parse_mp4_chunk_offsets(
    file: &mut File,
    start: u64,
    end: u64,
    track: &mut Mp4Track,
    wide: bool,
) -> bool {
    let width = if wide { 8 } else { 4 };
    let Some(count) = read_mp4_entry_count(file, start, end, width) else {
        return false;
    };
    track.chunk_offsets.clear();
    for _ in 0..count {
        let mut value = [0; 8];
        if !read_exact(file, &mut value[..width as usize]) {
            return false;
        }
        track.chunk_offsets.push(if wide {
            u64::from_be_bytes(value)
        } else {
            u64::from(u32::from_be_bytes(value[..4].try_into().unwrap()))
        });
    }
    true
}

fn validate_mp4_track(file: &mut File, track: &Mp4Track, mdats: &[(u64, u64)]) -> bool {
    let Some(nal_width) = track.nal_length_bytes else {
        return false;
    };
    if !track.video_handler
        || track.sample_sizes.len() == 0
        || track.chunk_offsets.is_empty()
        || track.sample_to_chunks.first().map(|entry| entry.0) != Some(1)
        || track.timed_sample_count != Some(track.sample_sizes.len() as u64)
    {
        return false;
    }
    if !track
        .sample_to_chunks
        .iter()
        .enumerate()
        .all(|(index, &(first, samples, description))| {
            first > 0
                && samples > 0
                && description == 1
                && (index == 0 || track.sample_to_chunks[index - 1].0 < first)
        })
        || track
            .sample_to_chunks
            .last()
            .is_none_or(|entry| entry.0 as usize > track.chunk_offsets.len())
    {
        return false;
    }
    let mut sample_index = 0_usize;
    for (chunk_index, chunk_offset) in track.chunk_offsets.iter().enumerate() {
        let chunk_number = chunk_index as u32 + 1;
        let Some((_, samples_per_chunk, description)) = track
            .sample_to_chunks
            .iter()
            .rev()
            .find(|entry| entry.0 <= chunk_number)
        else {
            return false;
        };
        if *samples_per_chunk == 0 || *description != 1 {
            return false;
        }
        let mut offset = *chunk_offset;
        for _ in 0..*samples_per_chunk {
            let Some(size) = track.sample_sizes.get(sample_index) else {
                return false;
            };
            let Some(end) = offset.checked_add(u64::from(size)) else {
                return false;
            };
            if size <= nal_width as u32
                || !mdats
                    .iter()
                    .any(|&(mdat_start, mdat_end)| offset >= mdat_start && end <= mdat_end)
                || !validate_length_prefixed_sample(file, offset, size, nal_width)
            {
                return false;
            }
            offset = end;
            sample_index += 1;
        }
    }
    sample_index == track.sample_sizes.len()
}

fn validate_length_prefixed_sample(file: &mut File, offset: u64, size: u32, width: usize) -> bool {
    let Some(sample_end) = offset.checked_add(u64::from(size)) else {
        return false;
    };
    let mut cursor = offset;
    let mut nal_units = 0_usize;
    let mut saw_video_slice = false;
    while cursor < sample_end {
        nal_units += 1;
        if nal_units > 10_000 || sample_end - cursor <= width as u64 {
            return false;
        }
        let mut prefix = [0_u8; 4];
        if file.seek(SeekFrom::Start(cursor)).is_err() || !read_exact(file, &mut prefix[..width]) {
            return false;
        }
        let length = prefix[..width]
            .iter()
            .fold(0_u32, |value, byte| (value << 8) | u32::from(*byte));
        cursor += width as u64;
        let Some(next) = cursor.checked_add(u64::from(length)) else {
            return false;
        };
        let mut nal_header = [0_u8; 1];
        if length == 0
            || next > sample_end
            || file.seek(SeekFrom::Start(cursor)).is_err()
            || !read_exact(file, &mut nal_header)
            || nal_header[0] & 0x80 != 0
        {
            return false;
        }
        saw_video_slice |= matches!(nal_header[0] & 0x1f, 1..=5);
        cursor = next;
    }
    cursor == sample_end && saw_video_slice
}

fn supported_mp4_brand(brand: &[u8]) -> bool {
    matches!(
        brand,
        b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"dash"
    )
}

fn validate_mp4_codec_configuration(
    file: &mut File,
    codec: &[u8],
    mut position: u64,
    end: u64,
) -> Option<usize> {
    let expected = match codec {
        b"avc1" | b"avc3" => b"avcC",
        _ => return None,
    };
    while position < end {
        if end - position < 8 || file.seek(SeekFrom::Start(position)).is_err() {
            return None;
        }
        let mut header = [0; 8];
        if !read_exact(file, &mut header) {
            return None;
        }
        let size = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        if size <= 8 || position.checked_add(size).is_none_or(|next| next > end) {
            return None;
        }
        if &header[4..8] == expected {
            let payload_len = usize::try_from(size - 8).ok()?;
            if payload_len > 65_536 {
                return None;
            }
            let mut payload = vec![0; payload_len];
            if !read_exact(file, &mut payload) {
                return None;
            }
            return validate_avcc(&payload);
        }
        position += size;
    }
    None
}

fn validate_avcc(payload: &[u8]) -> Option<usize> {
    if payload.len() < 7
        || payload[0] != 1
        || payload[4] & 0xfc != 0xfc
        || payload[5] & 0xe0 != 0xe0
    {
        return None;
    }
    let width = usize::from((payload[4] & 3) + 1);
    if width == 3 {
        return None;
    }
    let mut cursor = 6_usize;
    let sps_count = payload[5] & 0x1f;
    if sps_count == 0 {
        return None;
    }
    let mut saw_sps = false;
    for _ in 0..sps_count {
        let length = usize::from(u16::from_be_bytes([
            *payload.get(cursor)?,
            *payload.get(cursor + 1)?,
        ]));
        cursor = cursor.checked_add(2)?;
        if length == 0 || cursor.checked_add(length)? > payload.len() {
            return None;
        }
        saw_sps |= validate_h264_sps(&payload[cursor..cursor + length], payload[1]);
        cursor += length;
    }
    let pps_count = *payload.get(cursor)?;
    cursor += 1;
    if pps_count == 0 {
        return None;
    }
    let mut saw_pps = false;
    for _ in 0..pps_count {
        let length = usize::from(u16::from_be_bytes([
            *payload.get(cursor)?,
            *payload.get(cursor + 1)?,
        ]));
        cursor = cursor.checked_add(2)?;
        if length == 0 || cursor.checked_add(length)? > payload.len() {
            return None;
        }
        saw_pps |= validate_h264_pps(&payload[cursor..cursor + length]);
        cursor += length;
    }
    if is_high_avc_profile(payload[1]) {
        let chroma_format = *payload.get(cursor)?;
        let bit_depth_luma = *payload.get(cursor.checked_add(1)?)?;
        let bit_depth_chroma = *payload.get(cursor.checked_add(2)?)?;
        let extension_count = *payload.get(cursor.checked_add(3)?)?;
        if chroma_format & 0xfc != 0xfc
            || bit_depth_luma & 0xf8 != 0xf8
            || bit_depth_chroma & 0xf8 != 0xf8
        {
            return None;
        }
        cursor = cursor.checked_add(4)?;
        for _ in 0..extension_count {
            let length = usize::from(u16::from_be_bytes([
                *payload.get(cursor)?,
                *payload.get(cursor.checked_add(1)?)?,
            ]));
            cursor = cursor.checked_add(2)?;
            let end = cursor.checked_add(length)?;
            let nal = payload.get(cursor..end)?;
            if length < 2 || nal[0] & 0x80 != 0 || nal[0] & 0x1f != 13 {
                return None;
            }
            cursor = end;
        }
    }
    (cursor == payload.len() && saw_sps && saw_pps).then_some(width)
}

fn is_high_avc_profile(profile: u8) -> bool {
    matches!(
        profile,
        44 | 83 | 86 | 100 | 110 | 118 | 122 | 128 | 134 | 135 | 138 | 139 | 144 | 244
    )
}

fn validate_h264_sps(nal: &[u8], profile: u8) -> bool {
    nal.len() >= 5
        && nal[0] & 0x80 == 0
        && nal[0] & 0x1f == 7
        && nal[1] == profile
        && nal[3] != 0
        && read_unsigned_exp_golomb(&nal[4..], 0).is_some_and(|(id, _)| id <= 31)
}

fn validate_h264_pps(nal: &[u8]) -> bool {
    if nal.len() < 2 || nal[0] & 0x80 != 0 || nal[0] & 0x1f != 8 {
        return false;
    }
    let Some((pps_id, bits)) = read_unsigned_exp_golomb(&nal[1..], 0) else {
        return false;
    };
    let Some((sps_id, _)) = read_unsigned_exp_golomb(&nal[1..], bits) else {
        return false;
    };
    pps_id <= 255 && sps_id <= 31
}

fn read_unsigned_exp_golomb(bytes: &[u8], mut bit: usize) -> Option<(u32, usize)> {
    let bit_len = bytes.len().checked_mul(8)?;
    let mut leading_zeroes = 0_u32;
    while bit < bit_len && bytes[bit / 8] & (0x80 >> (bit % 8)) == 0 {
        leading_zeroes = leading_zeroes.checked_add(1)?;
        if leading_zeroes > 31 {
            return None;
        }
        bit = bit.checked_add(1)?;
    }
    if bit >= bit_len {
        return None;
    }
    bit = bit.checked_add(1)?;
    let mut value = 0_u32;
    for _ in 0..leading_zeroes {
        if bit >= bit_len {
            return None;
        }
        value = (value << 1) | u32::from((bytes[bit / 8] >> (7 - bit % 8)) & 1);
        bit = bit.checked_add(1)?;
    }
    Some(((1_u32 << leading_zeroes) - 1 + value, bit))
}

#[cfg(test)]
mod tests {
    use super::validate_avcc;

    #[test]
    fn accepts_ffmpeg_high_profile_avcc_extensions() {
        let avcc = [
            0x01, 0x64, 0x00, 0x0a, 0xff, 0xe1, 0x00, 0x18, 0x67, 0x64, 0x00, 0x0a, 0xac, 0xd9,
            0x44, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8,
            0x3c, 0x48, 0x96, 0x58, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0xfd,
            0xf8, 0xf8, 0x00,
        ];
        assert_eq!(validate_avcc(&avcc), Some(4));
    }

    #[test]
    fn rejects_type_only_or_forbidden_h264_parameter_sets() {
        for avcc in [
            vec![1, 66, 0, 30, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 2, 0x68, 0xc0],
            vec![
                1, 66, 0, 30, 0xff, 0xe1, 0, 5, 0xe7, 66, 0, 30, 0x80, 1, 0, 2, 0x68, 0xc0,
            ],
            vec![
                1, 66, 0, 30, 0xff, 0xe1, 0, 5, 0x67, 66, 0, 30, 0x80, 1, 0, 1, 0x68,
            ],
        ] {
            assert_eq!(validate_avcc(&avcc), None);
        }
    }
}

#[derive(Default)]
struct WebmState {
    doc_type: bool,
    video_track: bool,
    block: bool,
    track_type: bool,
    codec: bool,
    track_number: Option<u64>,
    video_track_numbers: Vec<u64>,
    pixel_width: Option<u64>,
    pixel_height: Option<u64>,
}

fn validate_webm(file: &mut File, byte_size: u64) -> bool {
    let mut state = WebmState::default();
    let mut elements_seen = 0_usize;
    parse_ebml_elements(file, 0, byte_size, 0, &mut state, &mut elements_seen)
        && state.doc_type
        && state.video_track
        && state.block
}

fn parse_ebml_elements(
    file: &mut File,
    start: u64,
    end: u64,
    depth: usize,
    state: &mut WebmState,
    elements_seen: &mut usize,
) -> bool {
    if depth > MAX_PARSE_DEPTH || file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut position = start;
    while position < end {
        *elements_seen += 1;
        if *elements_seen > MAX_CONTAINER_ELEMENTS {
            return false;
        }
        let (id, id_width) = match read_ebml_vint(file, true) {
            Some(value) => value,
            None => return false,
        };
        let (size, size_width) = match read_ebml_vint(file, false) {
            Some(value) => value,
            None => return false,
        };
        let payload_start = position + id_width as u64 + size_width as u64;
        let payload_end = match payload_start.checked_add(size) {
            Some(value) if value <= end => value,
            _ => return false,
        };
        match id {
            0x1a45dfa3 | 0x18538067 | 0x1654ae6b | 0xe0 => {
                if !parse_ebml_elements(
                    file,
                    payload_start,
                    payload_end,
                    depth + 1,
                    state,
                    elements_seen,
                ) {
                    return false;
                }
            }
            0xae => {
                let mut track = WebmState::default();
                if !parse_ebml_elements(
                    file,
                    payload_start,
                    payload_end,
                    depth + 1,
                    &mut track,
                    elements_seen,
                ) {
                    return false;
                }
                if track.track_type
                    && track.codec
                    && track.pixel_width.is_some_and(|value| value > 0)
                    && track.pixel_height.is_some_and(|value| value > 0)
                {
                    let Some(number) = track.track_number else {
                        return false;
                    };
                    if number == 0 || state.video_track_numbers.contains(&number) {
                        return false;
                    }
                    state.video_track_numbers.push(number);
                    state.video_track = true;
                }
            }
            0x4282 | 0x86 => {
                if size > 64 {
                    return false;
                }
                let mut value = vec![0; size as usize];
                if !read_exact(file, &mut value) {
                    return false;
                }
                if id == 0x4282 {
                    state.doc_type |= value == b"webm";
                } else {
                    state.codec |= matches!(value.as_slice(), b"V_VP8" | b"V_VP9");
                }
            }
            0xd7 => {
                let mut value = [0; 8];
                if size == 0 || size > 8 || !read_exact(file, &mut value[..size as usize]) {
                    return false;
                }
                let number = value[..size as usize]
                    .iter()
                    .fold(0_u64, |number, byte| (number << 8) | u64::from(*byte));
                if number == 0 {
                    return false;
                }
                track_number_set(state, number);
            }
            0x83 => {
                let mut value = [0; 8];
                if size == 0 || size > 8 || !read_exact(file, &mut value[..size as usize]) {
                    return false;
                }
                state.track_type |= value[..size as usize]
                    .iter()
                    .fold(0_u64, |number, byte| (number << 8) | u64::from(*byte))
                    == 1;
            }
            0xb0 | 0xba => {
                let Some(value) = read_ebml_uint(file, size) else {
                    return false;
                };
                if value == 0 || value > u64::from(MAX_DIMENSION) {
                    return false;
                }
                if id == 0xb0 {
                    state.pixel_width = Some(value);
                } else {
                    state.pixel_height = Some(value);
                }
            }
            0x1f43b675 => {
                if !parse_ebml_elements(
                    file,
                    payload_start,
                    payload_end,
                    depth + 1,
                    state,
                    elements_seen,
                ) {
                    return false;
                }
            }
            0xa3 => {
                let Some((track_number, width)) = read_ebml_vint(file, false) else {
                    return false;
                };
                let mut block_header = [0; 3];
                if size <= width as u64 + block_header.len() as u64
                    || !read_exact(file, &mut block_header)
                    || block_header[2] & 0x06 != 0
                {
                    return false;
                }
                state.block |= state.video_track_numbers.contains(&track_number);
            }
            _ => {}
        }
        position = payload_end;
        if file.seek(SeekFrom::Start(position)).is_err() {
            return false;
        }
    }
    position == end
}

fn read_ebml_uint<R: Read>(reader: &mut R, size: u64) -> Option<u64> {
    if size == 0 || size > 8 {
        return None;
    }
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes[..size as usize]).ok()?;
    Some(
        bytes[..size as usize]
            .iter()
            .fold(0_u64, |value, byte| (value << 8) | u64::from(*byte)),
    )
}

fn track_number_set(state: &mut WebmState, number: u64) {
    state.track_number = match state.track_number {
        None => Some(number),
        Some(existing) if existing == number => Some(existing),
        Some(_) => None,
    };
}

fn read_ebml_vint<R: Read>(reader: &mut R, keep_marker: bool) -> Option<(u64, usize)> {
    let mut first = [0];
    reader.read_exact(&mut first).ok()?;
    let width = first[0].leading_zeros() as usize + 1;
    if width > 8 || (keep_marker && width > 4) {
        return None;
    }
    let marker = 1_u8 << (8 - width);
    let mut value = if keep_marker {
        u64::from(first[0])
    } else {
        u64::from(first[0] & !marker)
    };
    for _ in 1..width {
        let mut byte = [0];
        reader.read_exact(&mut byte).ok()?;
        value = (value << 8) | u64::from(byte[0]);
    }
    let unknown = !keep_marker && value == (1_u64 << (7 * width)) - 1;
    (!unknown).then_some((value, width))
}
