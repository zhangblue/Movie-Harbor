use super::MediaError;
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
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
        const SUPPORTED: [&str; 3] = ["video/mp4", "video/webm", "video/ogg"];
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
        "image/jpeg" => validate_jpeg(file, byte_size),
        "image/png" => validate_png(file, byte_size),
        "image/webp" => validate_webp(file, byte_size),
        "video/mp4" => validate_mp4(file, byte_size),
        "video/webm" => validate_webm(file, byte_size),
        "video/ogg" => validate_ogg_video(file, byte_size),
        _ => false,
    };
    matches.then_some(()).ok_or(MediaError::ContentMismatch)
}

const MAX_DIMENSION: u32 = 16_384;
const MAX_PARSE_DEPTH: usize = 8;

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

#[derive(Default)]
struct Mp4State {
    ftyp: bool,
    mdat: bool,
    video_track: bool,
    handler: bool,
    codec: bool,
    samples: bool,
}

fn validate_mp4(file: &mut File, byte_size: u64) -> bool {
    let mut state = Mp4State::default();
    parse_mp4_boxes(file, 0, byte_size, 0, &mut state)
        && state.ftyp
        && state.mdat
        && state.video_track
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
                if !(8..=256).contains(&payload_len) {
                    return false;
                }
                let mut brands = vec![0; payload_len as usize];
                if !read_exact(file, &mut brands) {
                    return false;
                }
                state.ftyp = supported_mp4_brand(&brands[..4])
                    || (8..brands.len())
                        .step_by(4)
                        .any(|offset| supported_mp4_brand(&brands[offset..offset + 4]));
            }
            b"mdat" => state.mdat |= payload_end > payload_start,
            b"trak" => {
                let mut track = Mp4State::default();
                if !parse_mp4_boxes(file, payload_start, payload_end, depth + 1, &mut track) {
                    return false;
                }
                state.video_track |= track.handler && track.codec && track.samples;
            }
            b"moov" | b"mdia" | b"minf" | b"stbl" => {
                if !parse_mp4_boxes(file, payload_start, payload_end, depth + 1, state) {
                    return false;
                }
            }
            b"hdlr" => {
                let mut payload = [0; 12];
                if payload_end - payload_start < 12 || !read_exact(file, &mut payload) {
                    return false;
                }
                state.handler |= &payload[8..12] == b"vide";
            }
            b"stsd" => {
                let mut payload = [0; 16];
                if payload_end - payload_start < 16 || !read_exact(file, &mut payload) {
                    return false;
                }
                let count = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                let entry_size = u64::from(u32::from_be_bytes(payload[8..12].try_into().unwrap()));
                let entry_start = payload_start + 8;
                let entry_end = entry_start.saturating_add(entry_size);
                state.codec |= count > 0
                    && entry_size >= 86
                    && entry_end <= payload_end
                    && validate_mp4_codec_configuration(
                        file,
                        &payload[12..16],
                        entry_start + 86,
                        entry_end,
                    );
            }
            b"stsz" => {
                let mut payload = [0; 12];
                if payload_end - payload_start < 12 || !read_exact(file, &mut payload) {
                    return false;
                }
                state.samples |= u32::from_be_bytes(payload[8..12].try_into().unwrap()) > 0;
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
) -> bool {
    let expected = match codec {
        b"avc1" | b"avc3" => b"avcC",
        b"hvc1" | b"hev1" => b"hvcC",
        b"vp09" => b"vpcC",
        b"av01" => b"av1C",
        _ => return false,
    };
    while position < end {
        if end - position < 8 || file.seek(SeekFrom::Start(position)).is_err() {
            return false;
        }
        let mut header = [0; 8];
        if !read_exact(file, &mut header) {
            return false;
        }
        let size = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        if size <= 8 || position.checked_add(size).is_none_or(|next| next > end) {
            return false;
        }
        if &header[4..8] == expected {
            return true;
        }
        position += size;
    }
    false
}

#[derive(Default)]
struct WebmState {
    doc_type: bool,
    video_track: bool,
    block: bool,
    track_type: bool,
    codec: bool,
}

fn validate_webm(file: &mut File, byte_size: u64) -> bool {
    let mut state = WebmState::default();
    parse_ebml_elements(file, 0, byte_size, 0, &mut state)
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
) -> bool {
    if depth > MAX_PARSE_DEPTH || file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut position = start;
    while position < end {
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
            0x1a45dfa3 | 0x18538067 | 0x1654ae6b => {
                if !parse_ebml_elements(file, payload_start, payload_end, depth + 1, state) {
                    return false;
                }
            }
            0xae => {
                let mut track = WebmState::default();
                if !parse_ebml_elements(file, payload_start, payload_end, depth + 1, &mut track) {
                    return false;
                }
                state.video_track |= track.track_type && track.codec;
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
                    state.codec |= matches!(
                        value.as_slice(),
                        b"V_VP8" | b"V_VP9" | b"V_AV1" | b"V_MPEG4/ISO/AVC"
                    );
                }
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
            0x1f43b675 => {
                if !parse_ebml_elements(file, payload_start, payload_end, depth + 1, state) {
                    return false;
                }
            }
            0xa3 => {
                let mut block = [0; 4];
                if size < 4 || !read_exact(file, &mut block) {
                    return false;
                }
                state.block |= block[0] & 0x80 != 0 && block[0] & 0x7f != 0;
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

fn validate_ogg_video(file: &mut File, byte_size: u64) -> bool {
    let mut position = 0_u64;
    let mut serial = None;
    let mut expected_sequence = 0_u32;
    let mut packet = Vec::new();
    let mut packet_index = 0_usize;
    let mut video_data = false;
    while position < byte_size {
        let mut header = [0; 27];
        if byte_size - position < 27
            || !read_exact(file, &mut header)
            || &header[..4] != b"OggS"
            || header[4] != 0
        {
            return false;
        }
        let segments = usize::from(header[26]);
        let mut lacing = vec![0; segments];
        if !read_exact(file, &mut lacing) {
            return false;
        }
        let body_size = lacing
            .iter()
            .map(|value| usize::from(*value))
            .sum::<usize>();
        if position + 27 + segments as u64 + body_size as u64 > byte_size {
            return false;
        }
        let mut body = vec![0; body_size];
        if !read_exact(file, &mut body) {
            return false;
        }
        let stored_crc = u32::from_le_bytes(header[22..26].try_into().unwrap());
        header[22..26].fill(0);
        let mut page = header.to_vec();
        page.extend_from_slice(&lacing);
        page.extend_from_slice(&body);
        if ogg_crc(&page) != stored_crc {
            return false;
        }
        let page_serial = u32::from_le_bytes(header[14..18].try_into().unwrap());
        let sequence = u32::from_le_bytes(header[18..22].try_into().unwrap());
        if serial.is_none() {
            if header[5] & 2 == 0 || sequence != 0 {
                return false;
            }
            serial = Some(page_serial);
        } else if serial != Some(page_serial) || sequence != expected_sequence {
            return false;
        }
        expected_sequence = sequence.saturating_add(1);
        let mut offset = 0;
        for length in lacing {
            let length = usize::from(length);
            if packet.len() + length > 65_536 {
                return false;
            }
            packet.extend_from_slice(&body[offset..offset + length]);
            if length < 255 {
                let valid = match packet_index {
                    0 => {
                        packet.len() >= 42
                            && packet.starts_with(b"\x80theora")
                            && &packet[7..10] >= [3, 2, 0].as_slice()
                            && u16::from_be_bytes([packet[10], packet[11]]) > 0
                            && u16::from_be_bytes([packet[12], packet[13]]) > 0
                    }
                    1 => packet.starts_with(b"\x81theora"),
                    2 => packet.starts_with(b"\x82theora"),
                    _ => {
                        video_data = !packet.is_empty();
                        true
                    }
                };
                if !valid {
                    return false;
                }
                packet_index += 1;
                packet.clear();
            }
            offset += length;
        }
        position += 27 + segments as u64 + body_size as u64;
    }
    packet_index >= 4 && video_data && position == byte_size
}

fn ogg_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}
