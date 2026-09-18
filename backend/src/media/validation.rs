use super::MediaError;
use h264_reader::{
    Context as H264Context,
    avcc::AvcDecoderConfigurationRecord,
    nal::{
        Nal, RefNal, UnitType,
        pps::{PicParamSetId, PicParameterSet},
        sps::{SeqParamSetId, SeqParameterSet},
    },
    rbsp::BitRead,
};
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
    // 元数据层只约束文件名、扩展名和声明 MIME；三者匹配后仍须校验实际字节内容。
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
    // 结构解析以 false/None 拒绝无效输入，统一映射为内容不匹配；图片还须通过受限解码复核。
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

// 尺寸、递归深度和图片分配上限分别约束恶意输入带来的内存与解析开销。
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
    // 先核对 PNG 签名，再逐 chunk 检查长度、CRC 和必要结构；像素流由后续解码器复核。
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
        // chunk 除数据外还占 12 字节（长度、类型、CRC），整个区间必须落在文件内。
        if position
            .checked_add(12)
            .and_then(|value| value.checked_add(length))
            .is_none_or(|end| end > byte_size)
        {
            return false;
        }
        let kind: [u8; 4] = header[4..].try_into().unwrap();
        // CRC 覆盖类型与数据；分块读取仅保留 IHDR 所需前缀，避免按声明长度分配。
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
        // IHDR 必须唯一且位于首个 chunk；IEND 必须在 IDAT 出现后以空数据结束整个文件。
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
    // 从 SOI 逐段寻找帧头和扫描段；EOI 只有在两者均出现且恰好位于文件末尾时才接受。
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
        // segment 长度包含长度字段自身的两字节，不包含前面的 marker。
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
            // SOS 后进入熵编码数据区，不能再按普通 segment 的边界寻找下一个 marker。
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
    // 熵编码区的 FF 00 是转义数据，FF D0–D7 是重启标记，连续 FF 是填充；其余值结束扫描区。
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
    // RIFF 声明长度不含起始八字节，加回后必须等于文件大小；VP8X 本身不算图像数据。
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
        // RIFF chunk 的奇数字节数据另占一字节填充，跳过时须把填充计入父容器边界。
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
        // VP8X 检查画布尺寸；VP8L 或 VP8 必须具备相应前缀，完整图像仍由后续解码器复核。
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

// 限制采样表分配、容器遍历和 HEVC 配置遍历，抑制恶意数量字段放大的内存与 CPU 开销。
const MAX_MP4_TABLE_ENTRIES: usize = 1_000_000;
const MAX_CONTAINER_ELEMENTS: usize = 100_000;
const MAX_HEVC_CONFIGURATION_ARRAYS: usize = 64;
const MAX_HEVC_NAL_UNITS: usize = 10_000;

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
    codec_configuration: Option<Mp4CodecConfiguration>,
    sample_description: Option<(u64, u64)>,
    sample_sizes: Mp4SampleSizes,
    chunk_offsets: Vec<u64>,
    sample_to_chunks: Vec<(u32, u32, u32)>,
    timed_sample_count: Option<u64>,
}

struct H264Configuration {
    nal_length_bytes: usize,
    context: H264Context,
}

enum Mp4CodecConfiguration {
    H264(H264Configuration),
    Hevc { nal_length_bytes: usize },
}

impl Mp4CodecConfiguration {
    fn nal_length_bytes(&self) -> usize {
        match self {
            Self::H264(config) => config.nal_length_bytes,
            Self::Hevc { nal_length_bytes } => *nal_length_bytes,
        }
    }
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
    // 容器解析收集媒体区间与轨道；必须至少有一个视频轨道通过配置、采样表和样本校验。
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
    // 先验证 box 完整落在父边界内，再递归解析；深度和数量上限用于约束恶意嵌套造成的资源消耗。
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
        // size=1 使用 64 位扩展长度和 16 字节头；size=0 不在本解析器支持范围内。
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
                    // hdlr 与 stsd 的出现顺序不固定，先收集位置，再仅对视频轨道解释样本描述。
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
    // 轨道内只递归 mdia/minf/stbl，并与外层共享 box 数量预算；此处只接受普通八字节 box 头。
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
    // 仅接受一个视频样本描述；跳过 86 字节样本项头后，在该样本项边界内寻找编码配置。
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
    let configuration =
        validate_mp4_codec_configuration(file, &entry[4..8], entry_start + 86, entry_end);
    if configuration
        .as_ref()
        .is_none_or(|configuration| match configuration {
            Mp4CodecConfiguration::H264(configuration) => !configuration.context.sps().all(|sps| {
                sps.pixel_dimensions().is_ok_and(|(width, height)| {
                    width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION
                })
            }),
            Mp4CodecConfiguration::Hevc { .. } => false,
        })
    {
        return false;
    }
    track.codec_configuration = configuration;
    track.codec_configuration.is_some()
}

fn read_mp4_entry_count(file: &mut File, start: u64, end: u64, width: u64) -> Option<usize> {
    // 在读取表项或分配向量前核对数量上限及“八字节表头 + 数量 × 表项宽度”的最小空间。
    let mut header = [0; 8];
    (end - start >= 8 && read_exact(file, &mut header)).then_some(())?;
    let count = usize::try_from(u32::from_be_bytes(header[4..8].try_into().ok()?)).ok()?;
    (count <= MAX_MP4_TABLE_ENTRIES
        && 8_u64.checked_add((count as u64).checked_mul(width)?)? <= end - start)
        .then_some(count)
}

fn parse_mp4_stts(file: &mut File, start: u64, end: u64, track: &mut Mp4Track) -> bool {
    // stts 每项给出样本数与单样本时长；这里只要求两者非零并累计样本数，不换算实际播放秒数。
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
        // 固定大小样本只保存大小与数量，避免为每个样本重复分配相同值。
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
    // stco 与 co64 分别保存 32 位和 64 位文件绝对偏移，读取时统一为 u64。
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
    // stts 与 stsz 样本数须一致；stsc 从第一个 chunk 起递增，且只能引用唯一的样本描述。
    let Some(configuration) = track.codec_configuration.as_ref() else {
        return false;
    };
    let nal_width = configuration.nal_length_bytes();
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
    // stsc 按一基 chunk 编号分段映射；从每个 chunk 的绝对偏移起，按 stsz 大小连续定位样本。
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
            // 每个完整样本须落在同一个 mdat 数据区间内，再按轨道配置校验其长度前缀 NAL。
            if size <= nal_width as u32
                || !mdats
                    .iter()
                    .any(|&(mdat_start, mdat_end)| offset >= mdat_start && end <= mdat_end)
                || !match configuration {
                    Mp4CodecConfiguration::H264(h264) => {
                        validate_length_prefixed_sample(file, offset, size, h264)
                    }
                    Mp4CodecConfiguration::Hevc { nal_length_bytes } => {
                        validate_hevc_sample(file, offset, size, *nal_length_bytes)
                    }
                }
            {
                return false;
            }
            offset = end;
            sample_index += 1;
        }
    }
    sample_index == track.sample_sizes.len()
}

fn validate_hevc_sample(file: &mut File, offset: u64, size: u32, width: usize) -> bool {
    // 按配置给出的长度前缀逐 NAL 检查边界，并限制数量；这里只读取两字节头，不解码 HEVC 负载。
    let Some(sample_end) = offset.checked_add(u64::from(size)) else {
        return false;
    };
    let mut cursor = offset;
    let mut nal_units = 0_usize;
    let mut saw_vcl = false;
    while cursor < sample_end {
        nal_units += 1;
        if nal_units > MAX_HEVC_NAL_UNITS || sample_end - cursor <= width as u64 {
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
        let mut nal_header = [0_u8; 2];
        // 禁止位必须为零，temporal_id_plus1 低三位必须非零；类型 0–31 计为 VCL。
        if length < nal_header.len() as u32
            || next > sample_end
            || file.seek(SeekFrom::Start(cursor)).is_err()
            || !read_exact(file, &mut nal_header)
            || nal_header[0] & 0x80 != 0
            || nal_header[1] & 0x07 == 0
        {
            return false;
        }
        saw_vcl |= (nal_header[0] >> 1) & 0x3f <= 31;
        cursor = next;
    }
    cursor == sample_end && saw_vcl
}

fn validate_length_prefixed_sample(
    file: &mut File,
    offset: u64,
    size: u32,
    h264: &H264Configuration,
) -> bool {
    let width = h264.nal_length_bytes;
    // NAL 必须非空且完整落在样本内；每个样本至多检查 10,000 个 NAL，并至少包含一个视频切片。
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
        // 只读最多 256 字节前缀来检查 NAL 头及切片参数集引用，不把整个视频样本载入内存。
        let mut nal_prefix = [0_u8; 256];
        let prefix_len = usize::try_from(length)
            .unwrap_or(usize::MAX)
            .min(nal_prefix.len());
        if length == 0
            || next > sample_end
            || file.seek(SeekFrom::Start(cursor)).is_err()
            || !read_exact(file, &mut nal_prefix[..prefix_len])
        {
            return false;
        }
        let nal = RefNal::new(
            &nal_prefix[..prefix_len],
            &[],
            prefix_len == length as usize,
        );
        let Ok(header) = nal.header() else {
            return false;
        };
        if matches!(
            header.nal_unit_type(),
            UnitType::SliceLayerWithoutPartitioningNonIdr
                | UnitType::SliceLayerWithoutPartitioningIdr
        ) {
            if !validate_slice_parameter_set(&nal, &h264.context) {
                return false;
            }
            saw_video_slice = true;
        }
        cursor = next;
    }
    cursor == sample_end && saw_video_slice
}

fn validate_slice_parameter_set(nal: &RefNal<'_>, context: &H264Context) -> bool {
    // 切片类型须在允许范围内，且其 PPS 与 PPS 指向的 SPS 都必须已登记；这里不完整解析切片。
    let mut bits = nal.rbsp_bits();
    if bits.read_ue("first_mb_in_slice").is_err() {
        return false;
    }
    let Ok(slice_type) = bits.read_ue("slice_type") else {
        return false;
    };
    if slice_type > 9 {
        return false;
    }
    let Ok(pps_id) = bits.read_ue("pic_parameter_set_id") else {
        return false;
    };
    let Ok(pps_id) = PicParamSetId::from_u32(pps_id) else {
        return false;
    };
    context
        .pps_by_id(pps_id)
        .and_then(|pps| context.sps_by_id(pps.seq_parameter_set_id))
        .is_some()
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
) -> Option<Mp4CodecConfiguration> {
    let expected = match codec {
        b"avc1" | b"avc3" => b"avcC",
        b"hvc1" | b"hev1" => b"hvcC",
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
            // 编码配置整体读入内存前限制为 64 KiB，避免信任 box 长度进行大额分配。
            if payload_len > 65_536 {
                return None;
            }
            let mut payload = vec![0; payload_len];
            if !read_exact(file, &mut payload) {
                return None;
            }
            return match expected {
                b"avcC" => validate_avcc(&payload).map(Mp4CodecConfiguration::H264),
                b"hvcC" => validate_hvcc(&payload)
                    .map(|nal_length_bytes| Mp4CodecConfiguration::Hevc { nal_length_bytes }),
                _ => None,
            };
        }
        position += size;
    }
    None
}

fn validate_hvcc(payload: &[u8]) -> Option<usize> {
    // 固定头至少 23 字节，指定保留位必须为一；长度前缀宽度取低两位加一，拒绝三字节形式。
    if payload.len() < 23
        || payload[0] != 1
        || payload[13] & 0xf0 != 0xf0
        || payload[15] & 0xfc != 0xfc
        || payload[16] & 0xfc != 0xfc
        || payload[17] & 0xf8 != 0xf8
        || payload[18] & 0xf8 != 0xf8
    {
        return None;
    }
    let width = usize::from((payload[21] & 0x03) + 1);
    if width == 3 {
        return None;
    }
    let array_count = usize::from(payload[22]);
    if array_count == 0 || array_count > MAX_HEVC_CONFIGURATION_ARRAYS {
        return None;
    }
    let mut cursor = 23_usize;
    let mut nal_units = 0_usize;
    let mut saw_vps = false;
    let mut saw_sps = false;
    let mut saw_pps = false;
    // 每个数组及 NAL 都须完整落在配置内；仅核对 NAL 头与声明类型，不解析参数集内部语义。
    for _ in 0..array_count {
        let array_header = *payload.get(cursor)?;
        if array_header & 0x40 != 0 {
            return None;
        }
        let declared_type = array_header & 0x3f;
        let count = usize::from(u16::from_be_bytes([
            *payload.get(cursor.checked_add(1)?)?,
            *payload.get(cursor.checked_add(2)?)?,
        ]));
        if count == 0 {
            return None;
        }
        cursor = cursor.checked_add(3)?;
        for _ in 0..count {
            nal_units = nal_units.checked_add(1)?;
            if nal_units > MAX_HEVC_NAL_UNITS {
                return None;
            }
            let length = usize::from(u16::from_be_bytes([
                *payload.get(cursor)?,
                *payload.get(cursor.checked_add(1)?)?,
            ]));
            cursor = cursor.checked_add(2)?;
            let end = cursor.checked_add(length)?;
            let nal = payload.get(cursor..end)?;
            if length < 2
                || nal[0] & 0x80 != 0
                || nal[1] & 0x07 == 0
                || (nal[0] >> 1) & 0x3f != declared_type
            {
                return None;
            }
            match declared_type {
                32 => saw_vps = true,
                33 => saw_sps = true,
                34 => saw_pps = true,
                _ => {}
            }
            cursor = end;
        }
    }
    // 配置须恰好消费完，并至少包含 VPS、SPS、PPS 三类参数集。
    (cursor == payload.len() && saw_vps && saw_sps && saw_pps).then_some(width)
}

fn validate_avcc(payload: &[u8]) -> Option<H264Configuration> {
    // 先核对固定头、保留位和一/二/四字节 NAL 长度前缀，再逐一检查非空 SPS/PPS 的声明边界。
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
    for _ in 0..sps_count {
        let length = usize::from(u16::from_be_bytes([
            *payload.get(cursor)?,
            *payload.get(cursor + 1)?,
        ]));
        cursor = cursor.checked_add(2)?;
        if length == 0 || cursor.checked_add(length)? > payload.len() {
            return None;
        }
        cursor += length;
    }
    let pps_count = *payload.get(cursor)?;
    cursor += 1;
    if pps_count == 0 {
        return None;
    }
    for _ in 0..pps_count {
        let length = usize::from(u16::from_be_bytes([
            *payload.get(cursor)?,
            *payload.get(cursor + 1)?,
        ]));
        cursor = cursor.checked_add(2)?;
        if length == 0 || cursor.checked_add(length)? > payload.len() {
            return None;
        }
        cursor += length;
    }
    // High Profile 可在 PPS 后直接结束；若有扩展字节，须检查完整扩展头及保留位。
    // 扩展 NAL 必须完整且至少两字节，禁止位为零、类型为 13；不解析其内部负载。
    if is_high_avc_profile(payload[1]) && cursor < payload.len() {
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
    if cursor != payload.len() {
        return None;
    }
    let avcc = AvcDecoderConfigurationRecord::try_from(payload).ok()?;
    let context = build_validated_h264_context(&avcc)?;
    // 解析后的参数集数量须与声明一致，防止重复 ID 覆盖后悄悄丢失参数集。
    (context.sps().count() == usize::from(sps_count)
        && context.pps().count() == usize::from(pps_count))
    .then_some(H264Configuration {
        nal_length_bytes: width,
        context,
    })
}

fn build_validated_h264_context(avcc: &AvcDecoderConfigurationRecord<'_>) -> Option<H264Context> {
    // 第三方 SPS/PPS 解析的错误及可展开 panic 都转为拒绝，不让畸形参数集沿该路径传播 panic。
    let mut context = H264Context::new();
    for encoded in avcc.sequence_parameter_sets() {
        let encoded = encoded.ok()?;
        let nal = RefNal::new(encoded, &[], true);
        let sps = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            SeqParameterSet::from_bits(nal.rbsp_bits())
        }))
        .ok()?
        .ok()?;
        // SPS 解析后先限制尺寸，再允许依赖它的 PPS 解析；PPS 的 slice-group 参数还须提前检查。
        if !safe_sps_for_dependent_parsing(&sps) {
            return None;
        }
        context.put_seq_param_set(sps);
    }
    for encoded in avcc.picture_parameter_sets() {
        let encoded = encoded.ok()?;
        let nal = RefNal::new(encoded, &[], true);
        if !prevalidate_pps_slice_groups(&nal, &context) {
            return None;
        }
        let pps = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            PicParameterSet::from_bits(&context, nal.rbsp_bits())
        }))
        .ok()?
        .ok()?;
        context.put_pic_param_set(pps);
    }
    Some(context)
}

fn safe_sps_for_dependent_parsing(sps: &SeqParameterSet) -> bool {
    // 同时限制宏块轴长、面积计算和最终像素尺寸，避免异常 SPS 放大后续 PPS 解析的资源需求。
    let Some(width_in_mbs) = sps.pic_width_in_mbs_minus1.checked_add(1) else {
        return false;
    };
    let Some(height_in_map_units) = sps.pic_height_in_map_units_minus1.checked_add(1) else {
        return false;
    };
    let max_macroblocks_per_axis = MAX_DIMENSION / 16;
    if width_in_mbs > max_macroblocks_per_axis
        || height_in_map_units > max_macroblocks_per_axis
        || width_in_mbs.checked_mul(height_in_map_units).is_none()
    {
        return false;
    }
    sps.pixel_dimensions().is_ok_and(|(width, height)| {
        width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION
    })
}

fn prevalidate_pps_slice_groups(nal: &RefNal<'_>, context: &H264Context) -> bool {
    // 在完整 PPS 解析前核对 SPS 引用、最多八个 slice group，以及各 map 类型中与图像大小相关的参数。
    let mut bits = nal.rbsp_bits();
    let Ok(pps_id) = bits.read_ue("pic_parameter_set_id") else {
        return false;
    };
    if PicParamSetId::from_u32(pps_id).is_err() {
        return false;
    }
    let Ok(sps_id) = bits.read_ue("seq_parameter_set_id") else {
        return false;
    };
    let Ok(sps_id) = SeqParamSetId::from_u32(sps_id) else {
        return false;
    };
    let Some(sps) = context.sps_by_id(sps_id) else {
        return false;
    };
    if bits.read_bool("entropy_coding_mode_flag").is_err()
        || bits
            .read_bool("bottom_field_pic_order_in_frame_present_flag")
            .is_err()
    {
        return false;
    }
    let Ok(slice_groups_minus_one) = bits.read_ue("num_slice_groups_minus1") else {
        return false;
    };
    if slice_groups_minus_one == 0 {
        return true;
    }
    if slice_groups_minus_one > 7 {
        return false;
    }
    let Some(pic_size) = sps
        .pic_width_in_mbs_minus1
        .checked_add(1)
        .and_then(|width| {
            sps.pic_height_in_map_units_minus1
                .checked_add(1)
                .and_then(|height| width.checked_mul(height))
        })
    else {
        return false;
    };
    let Ok(map_type) = bits.read_ue("slice_group_map_type") else {
        return false;
    };
    match map_type {
        0 => (0..=slice_groups_minus_one).all(|_| {
            bits.read_ue("run_length_minus1")
                .is_ok_and(|value| value < pic_size)
        }),
        1 => true,
        2 => (0..slice_groups_minus_one).all(|_| {
            let Ok(top_left) = bits.read_ue("top_left") else {
                return false;
            };
            let Ok(bottom_right) = bits.read_ue("bottom_right") else {
                return false;
            };
            top_left <= bottom_right && bottom_right < pic_size
        }),
        3..=5 => {
            bits.read_bool("slice_group_change_direction_flag").is_ok()
                && bits
                    .read_ue("slice_group_change_rate_minus1")
                    .is_ok_and(|value| value < pic_size)
        }
        6 => bits
            .read_ue("pic_size_in_map_units_minus1")
            .is_ok_and(|value| value < pic_size),
        _ => false,
    }
}

fn is_high_avc_profile(profile: u8) -> bool {
    matches!(
        profile,
        44 | 83 | 86 | 100 | 110 | 118 | 122 | 128 | 134 | 135 | 138 | 139 | 144 | 244
    )
}

#[cfg(test)]
mod tests {
    use super::{validate_avcc, validate_hvcc};

    fn minimal_hvcc(length_size_minus_one: u8, parameter_set_types: &[u8]) -> Vec<u8> {
        let mut payload = vec![
            0x01,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x1e,
            0xf0,
            0x00,
            0xfc,
            0xfd,
            0xf8,
            0xf8,
            0x00,
            0x00,
            0x0c | length_size_minus_one,
            parameter_set_types.len() as u8,
        ];
        for &nal_type in parameter_set_types {
            payload.push(0x80 | nal_type);
            payload.extend_from_slice(&1_u16.to_be_bytes());
            payload.extend_from_slice(&2_u16.to_be_bytes());
            payload.extend_from_slice(&[nal_type << 1, 0x01]);
        }
        payload
    }

    #[test]
    fn accepts_hvcc_with_one_two_or_four_byte_nal_lengths() {
        for (length_size_minus_one, expected_width) in [(0, 1), (1, 2), (3, 4)] {
            let payload = minimal_hvcc(length_size_minus_one, &[32, 33, 34]);
            assert_eq!(validate_hvcc(&payload), Some(expected_width));
        }
    }

    #[test]
    fn rejects_reserved_three_byte_hevc_nal_length_prefix() {
        let payload = minimal_hvcc(2, &[32, 33, 34]);
        assert_eq!(validate_hvcc(&payload), None);
    }

    #[test]
    fn rejects_hvcc_missing_vps_sps_or_pps() {
        for parameter_set_types in [&[33, 34][..], &[32, 34], &[32, 33]] {
            let payload = minimal_hvcc(3, parameter_set_types);
            assert_eq!(validate_hvcc(&payload), None);
        }
    }

    #[test]
    fn rejects_truncated_or_not_fully_consumed_hvcc_arrays() {
        let valid = minimal_hvcc(3, &[32, 33, 34]);
        for truncated_length in [22, 23, 24, 25, 26, valid.len() - 1] {
            assert_eq!(validate_hvcc(&valid[..truncated_length]), None);
        }

        let mut oversized_nal = valid.clone();
        oversized_nal[26..28].copy_from_slice(&u16::MAX.to_be_bytes());
        assert_eq!(validate_hvcc(&oversized_nal), None);

        let mut trailing = valid;
        trailing.push(0);
        assert_eq!(validate_hvcc(&trailing), None);
    }

    #[test]
    fn rejects_hvcc_array_type_that_differs_from_nal_header() {
        let mut payload = minimal_hvcc(3, &[32, 33, 34]);
        payload[28] = 33 << 1;
        assert_eq!(validate_hvcc(&payload), None);
    }

    #[test]
    fn rejects_invalid_hevc_parameter_set_nal_headers() {
        let valid = minimal_hvcc(3, &[32, 33, 34]);
        let mut forbidden = valid.clone();
        forbidden[28] |= 0x80;
        assert_eq!(validate_hvcc(&forbidden), None);

        let mut missing_temporal_id = valid;
        missing_temporal_id[29] = 0;
        assert_eq!(validate_hvcc(&missing_temporal_id), None);
    }

    #[test]
    fn rejects_invalid_hvcc_reserved_bits() {
        for index in [13, 15, 16, 17, 18] {
            let mut payload = minimal_hvcc(3, &[32, 33, 34]);
            payload[index] = 0;
            assert_eq!(validate_hvcc(&payload), None, "accepted byte {index}");
        }

        let mut array_reserved_bit = minimal_hvcc(3, &[32, 33, 34]);
        array_reserved_bit[23] |= 0x40;
        assert_eq!(validate_hvcc(&array_reserved_bit), None);
    }

    #[test]
    fn accepts_hvcc_with_unknown_temporal_layers() {
        for (length_size_minus_one, expected_width) in [(0, 1), (1, 2), (3, 4)] {
            let mut payload = minimal_hvcc(length_size_minus_one, &[32, 33, 34]);
            payload[21] &= !0x38;
            assert_eq!(validate_hvcc(&payload), Some(expected_width));
        }
    }

    #[test]
    fn rejects_hvcc_with_excessive_array_or_nal_counts() {
        let mut array_types = vec![32, 33, 34];
        array_types.resize(65, 39);
        assert_eq!(validate_hvcc(&minimal_hvcc(3, &array_types)), None);

        let mut payload = minimal_hvcc(3, &[]);
        payload[22] = 3;
        payload.push(0x80 | 32);
        payload.extend_from_slice(&10_001_u16.to_be_bytes());
        for _ in 0..10_001 {
            payload.extend_from_slice(&[0, 2, 32 << 1, 1]);
        }
        for nal_type in [33, 34] {
            payload.push(0x80 | nal_type);
            payload.extend_from_slice(&1_u16.to_be_bytes());
            payload.extend_from_slice(&[0, 2, nal_type << 1, 1]);
        }
        assert_eq!(validate_hvcc(&payload), None);
    }

    #[test]
    fn malformed_hvcc_never_panics() {
        for length in 0..512_usize {
            let payload = (0..length)
                .map(|index| (index.wrapping_mul(193) ^ length.wrapping_mul(29)) as u8)
                .collect::<Vec<_>>();
            assert!(std::panic::catch_unwind(|| validate_hvcc(&payload)).is_ok());
        }
    }

    #[test]
    fn accepts_ffmpeg_high_profile_avcc_extensions() {
        let avcc = [
            0x01, 0x64, 0x00, 0x0a, 0xff, 0xe1, 0x00, 0x18, 0x67, 0x64, 0x00, 0x0a, 0xac, 0xd9,
            0x44, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8,
            0x3c, 0x48, 0x96, 0x58, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0xfd,
            0xf8, 0xf8, 0x00,
        ];
        assert_eq!(
            validate_avcc(&avcc).map(|configuration| configuration.nal_length_bytes),
            Some(4)
        );
    }

    #[test]
    fn accepts_high_profile_avcc_without_extensions_but_rejects_partial_extensions() {
        let avcc = [
            0x01, 0x64, 0x00, 0x0a, 0xff, 0xe1, 0x00, 0x18, 0x67, 0x64, 0x00, 0x0a, 0xac, 0xd9,
            0x44, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8,
            0x3c, 0x48, 0x96, 0x58, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0xfd,
            0xf8, 0xf8, 0x00,
        ];
        let core = &avcc[..avcc.len() - 4];
        assert_eq!(
            validate_avcc(core).map(|configuration| configuration.nal_length_bytes),
            Some(4),
        );
        for trailing_length in 1..4 {
            assert!(validate_avcc(&avcc[..core.len() + trailing_length]).is_none());
        }
    }

    #[test]
    fn rejects_malformed_high_profile_avcc_extensions() {
        let avcc = [
            0x01, 0x64, 0x00, 0x0a, 0xff, 0xe1, 0x00, 0x18, 0x67, 0x64, 0x00, 0x0a, 0xac, 0xd9,
            0x44, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8,
            0x3c, 0x48, 0x96, 0x58, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0xfd,
            0xf8, 0xf8, 0x00,
        ];
        let core = &avcc[..avcc.len() - 4];
        let mut valid = core.to_vec();
        valid.extend([0xfd, 0xf8, 0xf8, 1, 0, 2, 0x0d, 0]);
        assert_eq!(
            validate_avcc(&valid).map(|configuration| configuration.nal_length_bytes),
            Some(4)
        );

        for (name, extension) in [
            ("trailing-after-header", vec![0xfd, 0xf8, 0xf8, 0, 0]),
            ("truncated-length", vec![0xfd, 0xf8, 0xf8, 1, 0]),
            ("truncated-content", vec![0xfd, 0xf8, 0xf8, 1, 0, 2, 0x0d]),
            ("zero-length", vec![0xfd, 0xf8, 0xf8, 1, 0, 0]),
            ("wrong-nal-type", vec![0xfd, 0xf8, 0xf8, 1, 0, 2, 0x01, 0]),
            (
                "forbidden-nal-bit",
                vec![0xfd, 0xf8, 0xf8, 1, 0, 2, 0x8d, 0],
            ),
            ("invalid-chroma-reserved-bits", vec![0xf9, 0xf8, 0xf8, 0]),
            ("invalid-luma-reserved-bits", vec![0xfd, 0xf0, 0xf8, 0]),
            (
                "invalid-chroma-bit-depth-reserved-bits",
                vec![0xfd, 0xf8, 0xf0, 0],
            ),
        ] {
            let mut payload = core.to_vec();
            payload.extend(extension);
            assert!(
                validate_avcc(&payload).is_none(),
                "malformed extension accepted: {name}"
            );
        }
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
            assert!(validate_avcc(&avcc).is_none());
        }
    }

    #[test]
    fn malformed_avcc_never_panics() {
        for length in 0..512_usize {
            let payload = (0..length)
                .map(|index| (index.wrapping_mul(191) ^ length.wrapping_mul(17)) as u8)
                .collect::<Vec<_>>();
            assert!(std::panic::catch_unwind(|| validate_avcc(&payload)).is_ok());
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
    // 必须识别 webm 文档类型、受支持的视频轨道，以及引用该轨道的 SimpleBlock；不解码视频帧。
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
    // EBML 只递归识别的容器，共享深度与元素数量预算；声明长度必须落在当前父元素内。
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
                // 每个 TrackEntry 单独收集类型、Codec ID、编号和尺寸，防止不同轨道的字段拼成有效轨道。
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
                // 文档类型和 Codec ID 最多读取 64 字节；视频编码只接受 VP8/VP9 对应的标识。
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
                // SimpleBlock 需有轨道号、三字节头和非空负载；标志位 0x06 必须为零，即不支持 lacing。
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
    // 首个值为 1 的位确定 VINT 宽度；元素 ID 保留该位且最多四字节，数值去掉该位且最多八字节。
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
    // 去掉宽度标志后全为一的未知长度形式不被接受，确保递归始终有明确的父边界。
    let unknown = !keep_marker && value == (1_u64 << (7 * width)) - 1;
    (!unknown).then_some((value, width))
}
