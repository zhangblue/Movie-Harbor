use axum::{
    Router,
    body::{Body, Bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use image::{ExtendedColorType, ImageEncoder};
use movie_harbor_api::{
    app,
    config::Config,
    entities::{episode, media_asset, movie, season, series},
    media::{
        AttachmentTarget, ChunkSource, LocalMediaStorage, MediaError, MediaKind, MediaStorageSet,
        StorageEvent, StorageHooks, UploadPolicy, replace_attachment, store_new_asset,
    },
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DatabaseBackend,
    DatabaseConnection, EntityTrait, IntoActiveModel, Set, Statement,
};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::time::{Duration, SystemTime};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

const HEVC_HVC1_MP4: &[u8] = include_bytes!("fixtures/hevc-hvc1.mp4");

fn jpeg() -> &'static [u8] {
    static BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BYTES.get_or_init(|| {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .write_image(&[24, 48, 96], 1, 1, ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    })
}

fn decode_base64(input: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("invalid fixture base64"),
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
            accumulator &= (1_u32 << bits) - 1;
        }
    }
    output
}

fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(payload.len() + 8);
    result.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
    result.extend_from_slice(kind);
    result.extend_from_slice(payload);
    result
}

fn incomplete_mp4() -> Vec<u8> {
    let mut ftyp = b"isom\0\0\x02\0isommp42".to_vec();
    ftyp = atom(b"ftyp", &ftyp);
    let hdlr = atom(b"hdlr", b"\0\0\0\0\0\0\0\0vide\0\0\0\0");
    let mut sample_payload = vec![0; 78];
    sample_payload.extend(atom(b"avcC", &[1, 66, 0, 30, 0xff]));
    let sample = atom(b"avc1", &sample_payload);
    let mut stsd_payload = vec![0; 8];
    stsd_payload[7] = 1;
    stsd_payload.extend_from_slice(&sample);
    let stsd = atom(b"stsd", &stsd_payload);
    let mut stsz_payload = vec![0; 12];
    stsz_payload[7] = 1;
    stsz_payload[11] = 1;
    let stsz = atom(b"stsz", &stsz_payload);
    let mut stbl_payload = stsd;
    stbl_payload.extend_from_slice(&stsz);
    let stbl = atom(b"stbl", &stbl_payload);
    let minf = atom(b"minf", &stbl);
    let mut mdia_payload = hdlr;
    mdia_payload.extend_from_slice(&minf);
    let mdia = atom(b"mdia", &mdia_payload);
    let trak = atom(b"trak", &mdia);
    let moov = atom(b"moov", &trak);
    let mdat = atom(b"mdat", &[1]);
    ftyp.extend_from_slice(&moov);
    ftyp.extend_from_slice(&mdat);
    ftyp
}

fn valid_mp4() -> Vec<u8> {
    decode_base64(
        "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMObW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAyDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAfZYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAKDAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM+AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACi21kYXQAAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQK8mKAAKe+",
    )
}

fn ffmpeg_baseline_h264_aac_mp4() -> Vec<u8> {
    decode_base64(
        "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",
    )
}

fn corrupt_ffmpeg_high_h264_mp4_fixture() -> Vec<u8> {
    decode_base64(
        "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",
    )
}

fn ffmpeg_high_h264_mp4() -> Vec<u8> {
    decode_base64(concat!(
        "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAvhtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gy",
        "NjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAt",
        "IGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBh",
        "bmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3Jhbmdl",
        "PTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21h",
        "X3FwX29mZnNldD0tMiB0aHJlYWRzPTIgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9",
        "MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJf",
        "YWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRf",
        "bWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4w",
        "IHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAIGWIhAAz//72",
        "7L4FNhTIUJcRLMWmfv3kQNkVIIcHMcRBAAAACkGaImxCv/44jcAAAAAIAZ5BeQr/DDkAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAA",
        "AAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAgAAAoh0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEA",
        "AAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAAB",
        "AAAAAAIAbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAABgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABW",
        "aWRlb0hhbmRsZXIAAAABq21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA",
        "AQAAAWtzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAAB",
        "FExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDIPEiW",
        "WAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAADD1QAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAwAAAgAA",
        "AAAUc3RzcwAAAAAAAAABAAAAAQAAAChjdHRzAAAAAAAAAAMAAAABAAAEAAAAAAEAAAYAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAAB",
        "AAAAAQAAAAMAAAABAAAAIHN0c3oAAAAAAAAAAAAAAAMAAALWAAAADgAAAAwAAAAUc3RjbwAAAAAAAAABAAAAMAAAAGF1ZHRhAAAA",
        "WW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABM",
        "YXZmNjMuMS4xMDE="
    ))
}

fn ffmpeg_high_h264_mp4_without_avcc_extensions() -> Vec<u8> {
    let bytes = ffmpeg_high_h264_mp4();
    let avcc = bytes.windows(4).position(|bytes| bytes == b"avcC").unwrap();
    let size = u32::from_be_bytes(bytes[avcc - 4..avcc].try_into().unwrap()) as usize;
    let mut payload = bytes[avcc + 4..avcc - 4 + size].to_vec();
    assert_eq!(&payload[payload.len() - 4..], &[0xfd, 0xf8, 0xf8, 0x00]);
    payload.truncate(payload.len() - 4);
    replace_mp4_avcc(bytes, payload)
}

fn valid_webp() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
        .write_image(&[24, 48, 96], 1, 1, ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() < 127);
    let mut result = id.to_vec();
    result.push(0x80 | payload.len() as u8);
    result.extend_from_slice(payload);
    result
}

fn structured_webm() -> Vec<u8> {
    let doc_type = ebml_element(&[0x42, 0x82], b"webm");
    let header = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &doc_type);
    let track_number = ebml_element(&[0xd7], &[1]);
    let track_type = ebml_element(&[0x83], &[1]);
    let codec = ebml_element(&[0x86], b"V_VP9");
    let mut entry_payload = track_number;
    entry_payload.extend(track_type);
    entry_payload.extend(codec);
    let entry = ebml_element(&[0xae], &entry_payload);
    let tracks = ebml_element(&[0x16, 0x54, 0xae, 0x6b], &entry);
    let cluster = ebml_element(
        &[0x1f, 0x43, 0xb6, 0x75],
        &ebml_element(&[0xa3], &[0x81, 0, 0, 0, 0x82]),
    );
    let mut segment_payload = tracks;
    segment_payload.extend(cluster);
    let segment = ebml_element(&[0x18, 0x53, 0x80, 0x67], &segment_payload);
    [header, segment].concat()
}

fn valid_webm() -> Vec<u8> {
    decode_base64(concat!(
        "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH1EU2bdLpNu4tTq4QV",
        "SalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHf7AEAAAAAAABZ",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxM",
        "YXZmNjMuMS4xMDFEiYhARAAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WITi+TBaEj/oCcgQAitZyDdW5k",
        "iIEAhoVWX1ZQOYOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5z",
        "c59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PZY8CLY8WITi+TBaEj/oBnyKRFo4dFTkNP",
        "REVSRIeXTGF2YzYzLjEuMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0MDAw",
        "MDAwMAAfQ7Z1peeBAKOggQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAAcU7trkbuPs4EAt4r3",
        "gQHxggG18IED"
    ))
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

fn ogg_page(serial: u32, sequence: u32, header_type: u8, packet: &[u8]) -> Vec<u8> {
    let mut page = b"OggS".to_vec();
    page.extend_from_slice(&[0, header_type]);
    page.extend_from_slice(&0_u64.to_le_bytes());
    page.extend_from_slice(&serial.to_le_bytes());
    page.extend_from_slice(&sequence.to_le_bytes());
    page.extend_from_slice(&0_u32.to_le_bytes());
    page.push(1);
    page.push(packet.len() as u8);
    page.extend_from_slice(packet);
    let checksum = ogg_crc(&page).to_le_bytes();
    page[22..26].copy_from_slice(&checksum);
    page
}

fn valid_ogg_video() -> Vec<u8> {
    let mut identification = vec![0; 42];
    identification[..7].copy_from_slice(b"\x80theora");
    identification[7..10].copy_from_slice(&[3, 2, 1]);
    identification[10..12].copy_from_slice(&1_u16.to_be_bytes());
    identification[12..14].copy_from_slice(&1_u16.to_be_bytes());
    identification[14..17].copy_from_slice(&[0, 0, 16]);
    identification[17..20].copy_from_slice(&[0, 0, 16]);
    identification[22..26].copy_from_slice(&30_u32.to_be_bytes());
    identification[26..30].copy_from_slice(&1_u32.to_be_bytes());
    identification[30..33].copy_from_slice(&[0, 0, 1]);
    identification[33..36].copy_from_slice(&[0, 0, 1]);
    let mut comment = b"\x81theora".to_vec();
    comment.extend(2_u32.to_le_bytes());
    comment.extend(b"mh");
    comment.extend(0_u32.to_le_bytes());
    let mut setup = b"\x82theora".to_vec();
    setup.extend([0x55; 16]);
    [
        ogg_page(1, 0, 2, &identification),
        ogg_page(1, 1, 0, &comment),
        ogg_page(1, 2, 0, &setup),
        ogg_page(1, 3, 0, b"\x00\x01"),
    ]
    .concat()
}

fn declared_sample_count_bomb() -> Vec<u8> {
    let mut data = atom(b"ftyp", b"isom\0\0\0\0");
    let mut stsz = vec![0; 4];
    stsz.extend(1_u32.to_be_bytes());
    stsz.extend(1_000_000_u32.to_be_bytes());
    for _ in 0..16 {
        data.extend(atom(b"trak", &atom(b"stsz", &stsz)));
    }
    data
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("movie_harbor_media_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl AsRef<Path> for TempRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Chunks {
    chunks: Vec<Bytes>,
    index: usize,
    polls: Arc<AtomicUsize>,
    inspect_before_second: Option<PathBuf>,
}

impl Chunks {
    fn new(chunks: impl IntoIterator<Item = &'static [u8]>) -> (Self, Arc<AtomicUsize>) {
        let polls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                chunks: chunks.into_iter().map(Bytes::from_static).collect(),
                index: 0,
                polls: polls.clone(),
                inspect_before_second: None,
            },
            polls,
        )
    }

    fn bytes(bytes: Vec<u8>) -> (Self, Arc<AtomicUsize>) {
        let polls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                chunks: vec![Bytes::from(bytes)],
                index: 0,
                polls: polls.clone(),
                inspect_before_second: None,
            },
            polls,
        )
    }

    fn inspect_incoming_before_second(mut self, root: &Path) -> Self {
        self.inspect_before_second = Some(root.join(".incoming"));
        self
    }
}

impl ChunkSource for Chunks {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            self.polls.fetch_add(1, Ordering::SeqCst);
            if self.index == 1
                && let Some(incoming) = &self.inspect_before_second
            {
                let sizes = std::fs::read_dir(incoming)
                    .unwrap()
                    .map(|entry| entry.unwrap().metadata().unwrap().len())
                    .collect::<Vec<_>>();
                assert_eq!(sizes, vec![self.chunks[0].len() as u64]);
            }
            let chunk = self.chunks.get(self.index).cloned();
            self.index += usize::from(chunk.is_some());
            Ok(chunk)
        })
    }
}

struct PausingChunks {
    first: bool,
}

struct BlockingChunks {
    started: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
    finished: bool,
}

impl ChunkSource for BlockingChunks {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        let started = self.started.take();
        let release = self.release.take();
        let finished = self.finished;
        self.finished = true;
        Box::pin(async move {
            if finished {
                return Ok(None);
            }
            started.unwrap().send(()).unwrap();
            release.unwrap().await.unwrap();
            Ok(Some(Bytes::from_static(PNG)))
        })
    }
}

impl ChunkSource for PausingChunks {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            if self.first {
                self.first = false;
                Ok(Some(Bytes::from_static(PNG)))
            } else {
                std::future::pending().await
            }
        })
    }
}

struct FailFirstUnlink {
    failed: AtomicBool,
}

struct FailFirstStage {
    failed: AtomicBool,
}

struct MakeOperationReadOnlyAfterCommit {
    root: PathBuf,
    operation: Mutex<Option<PathBuf>>,
}

struct FailIncomingSyncAfterCommit {
    committed: AtomicBool,
}

impl StorageHooks for FailIncomingSyncAfterCommit {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::DatabaseCommitted(_)) {
            self.committed.store(true, Ordering::SeqCst);
        } else if self.committed.load(Ordering::SeqCst)
            && matches!(event, StorageEvent::DirectorySynced(path) if path == ".incoming")
        {
            return Err(std::io::Error::other(
                "injected post-commit marker sync failure",
            ));
        }
        Ok(())
    }
}

impl StorageHooks for MakeOperationReadOnlyAfterCommit {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if !matches!(event, StorageEvent::DatabaseCommitted(_)) {
            return Ok(());
        }
        let operation = std::fs::read_dir(self.root.join(".operations"))?
            .next()
            .ok_or_else(|| std::io::Error::other("missing staged replacement operation"))??
            .path();
        std::fs::set_permissions(&operation, std::fs::Permissions::from_mode(0o500))?;
        *self.operation.lock().unwrap() = Some(operation);
        Ok(())
    }
}

impl StorageHooks for FailFirstStage {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::BeforeStage(_))
            && !self.failed.swap(true, Ordering::SeqCst)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected replacement staging failure with sensitive detail",
            ));
        }
        Ok(())
    }
}

impl StorageHooks for FailFirstUnlink {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::BeforeUnlink(_))
            && !self.failed.swap(true, Ordering::SeqCst)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected unlink failure with sensitive detail",
            ));
        }
        Ok(())
    }
}

fn policy(max_bytes: u64) -> UploadPolicy {
    UploadPolicy::new(max_bytes, ["video/mp4", "video/webm"]).unwrap()
}

async fn database() -> DatabaseConnection {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("media_upload_test_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut options = ConnectOptions::new(url);
    options.set_schema_search_path(schema);
    let db = Database::connect(options).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
    db
}

fn config(root: &Path) -> Config {
    std::fs::write(
        root.join(".movie-harbor-volume.json"),
        r#"{"version":1,"volume":0}"#,
    )
    .unwrap();
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dirs: vec![root.into()],
        media_disk_reserve_bytes: 1,
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 4096,
        allowed_video_mime_types: vec!["video/mp4".into(), "video/webm".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn draft_movie(db: &DatabaseConnection, poster_asset_id: Option<Uuid>) -> movie::Model {
    movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Draft".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(poster_asset_id),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn only_file(root: &Path, key: &str) -> bool {
    tokio::fs::metadata(root.join(key)).await.is_ok()
}

fn count_files(path: &Path) -> usize {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| if path.is_dir() { count_files(&path) } else { 1 })
        .sum()
}

#[cfg(unix)]
fn write_pending_marker(root: &Path, id: Uuid, key: &str, owner: &Path) -> PathBuf {
    let metadata = std::fs::metadata(owner).unwrap();
    let bytes = std::fs::read(owner).unwrap();
    let marker = root
        .join(".incoming")
        .join(format!("{}.pending", id.simple()));
    std::fs::write(
        &marker,
        serde_json::to_vec(&json!({
            "version": 1,
            "storage_key": key,
            "device": metadata.dev(),
            "inode": metadata.ino(),
            "byte_size": metadata.len(),
            "checksum_sha256": format!("{:x}", Sha256::digest(&bytes)),
        }))
        .unwrap(),
    )
    .unwrap();
    marker
}

fn make_stale(path: &Path) {
    let file = std::fs::File::open(path).unwrap();
    file.set_times(
        std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7200)),
    )
    .unwrap();
}

#[derive(Default)]
struct RecordingHooks {
    events: Mutex<Vec<StorageEvent>>,
}

impl StorageHooks for RecordingHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}

enum AdversarialAction {
    Collision,
    ReplaceParentWithSymlink(PathBuf),
    ReplaceSourceWithSymlink(PathBuf),
}

struct AdversarialHooks {
    root: PathBuf,
    action: AdversarialAction,
    fired: AtomicBool,
}

impl StorageHooks for AdversarialHooks {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if !matches!(event, StorageEvent::BeforePromote(_))
            || self.fired.swap(true, Ordering::SeqCst)
        {
            return Ok(());
        }
        let StorageEvent::BeforePromote(key) = event else {
            unreachable!()
        };
        let target = self.root.join(key);
        match &self.action {
            AdversarialAction::Collision => std::fs::write(target, b"collision"),
            AdversarialAction::ReplaceParentWithSymlink(outside) => {
                let parent = target.parent().unwrap();
                let moved = parent.with_extension("moved");
                std::fs::rename(parent, &moved)?;
                std::os::unix::fs::symlink(outside, parent)?;
                std::fs::write(outside.join(target.file_name().unwrap()), b"outside")
            }
            AdversarialAction::ReplaceSourceWithSymlink(outside) => {
                let part = std::fs::read_dir(self.root.join(".incoming"))?
                    .map(|entry| entry.map(|entry| entry.path()))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .find(|path| path.extension() == Some(std::ffi::OsStr::new("part")))
                    .ok_or_else(|| std::io::Error::other("missing upload part"))?;
                std::fs::remove_file(&part)?;
                std::os::unix::fs::symlink(outside, part)
            }
        }
    }
}

struct PauseAfterDatabaseCommit {
    commits: AtomicUsize,
}

struct ReplaceAtOwnedUnlink {
    root: PathBuf,
    replaced: AtomicBool,
    no_quarantine_data_before_claim: AtomicBool,
    key: Mutex<Option<String>>,
}

impl StorageHooks for ReplaceAtOwnedUnlink {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        let StorageEvent::BeforeUnlink(key) = event else {
            return Ok(());
        };
        if self.replaced.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.no_quarantine_data_before_claim.store(
            std::fs::read_dir(self.root.join(".quarantine"))?.all(|entry| {
                entry
                    .map(|entry| entry.path().extension() != Some(std::ffi::OsStr::new("data")))
                    .unwrap_or(false)
            }),
            Ordering::SeqCst,
        );
        *self.key.lock().unwrap() = Some(key.clone());
        let formal = self.root.join(key);
        std::fs::rename(&formal, formal.with_extension("owned-original"))?;
        std::fs::write(formal, b"UNRELATED REPLACEMENT")
    }
}

impl StorageHooks for PauseAfterDatabaseCommit {
    fn on_event(&self, event: &StorageEvent) -> std::io::Result<()> {
        if matches!(event, StorageEvent::DatabaseCommitted(_)) {
            self.commits.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

async fn json_request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json");
    if let Some(value) = cookie {
        builder = builder.header("cookie", value);
    }
    if let Some(value) = csrf {
        builder = builder.header("x-csrf-token", value);
    }
    if let Some(value) = origin {
        builder = builder.header("origin", value);
    }
    let mut request = builder.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn credentials(app: &Router) -> (String, String) {
    let login = json_request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        None,
        None,
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = json_request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let body: Value =
        serde_json::from_slice(&session.into_body().collect().await.unwrap().to_bytes()).unwrap();
    (cookie, body["csrf_token"].as_str().unwrap().to_owned())
}

fn multipart_request(
    path: String,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: &str,
) -> Request<Body> {
    multipart_file_request(
        path,
        cookie,
        csrf,
        origin,
        "movie.mp4",
        "video/mp4",
        valid_mp4(),
    )
}

fn multipart_file_request(
    path: String,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: &str,
    filename: &str,
    mime_type: &str,
    contents: Vec<u8>,
) -> Request<Body> {
    let boundary = "movie-harbor-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n"
    ).into_bytes();
    body.extend_from_slice(&contents);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "harbor.test")
        .header("origin", origin)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        );
    if let Some(value) = cookie {
        builder = builder.header("cookie", value);
    }
    if let Some(value) = csrf {
        builder = builder.header("x-csrf-token", value);
    }
    let mut request = builder.body(Body::from(body)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    request
}

fn raw_multipart_request(
    path: String,
    cookie: &str,
    csrf: &str,
    boundary: &str,
    body: Vec<u8>,
) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    request
}

// Catches ignoring all but the first configured volume in actual upload routes.
#[tokio::test]
async fn multi_volume_all_attachment_slots_persist_the_selected_volume() {
    let db = database().await;
    let roots = [volume_root(0), volume_root(1)];
    let mut config = config(roots[0].as_ref());
    config.media_dirs.push(roots[1].as_ref().to_path_buf());
    let app = app::build(db.clone(), &config).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    // Removing write permission makes volume 0 unavailable without simulating capacity.
    std::fs::set_permissions(roots[0].as_ref(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let movie = draft_movie(&db, None).await;
    let series = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Series".into()),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let season = season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series.id),
        number: Set(1),
    }
    .insert(&db)
    .await
    .unwrap();
    let episode = episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season.id),
        number: Set(1),
        name: Set("Episode".into()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    for (path, filename, mime, bytes) in [
        (
            format!("/api/admin/media/movies/{}/poster?version=1", movie.id),
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ),
        (
            format!("/api/admin/media/movies/{}/video?version=2", movie.id),
            "movie.mp4",
            "video/mp4",
            valid_mp4(),
        ),
        (
            format!("/api/admin/media/series/{}/poster?version=1", series.id),
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ),
        (
            format!("/api/admin/media/episodes/{}/video?version=1", episode.id),
            "episode.mp4",
            "video/mp4",
            valid_mp4(),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(multipart_file_request(
                path,
                Some(&cookie),
                Some(&csrf),
                "https://harbor.test",
                filename,
                mime,
                bytes,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let assets = media_asset::Entity::find().all(&db).await.unwrap();
    assert_eq!(assets.len(), 4);
    for asset in &assets {
        assert_eq!(asset.storage_volume, 1);
        assert!(roots[1].as_ref().join(&asset.storage_key).is_file());
        assert!(!roots[0].as_ref().join(&asset.storage_key).is_file());
    }
    let published = json_request(
        &app,
        "POST",
        &format!("/api/admin/movies/{}/publish", movie.id),
        json!({"version":3,"status":"published"}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(published.status(), StatusCode::OK);
    let detail = json_request(
        &app,
        "GET",
        &format!("/api/catalog/movies/{}", movie.id),
        json!(null),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(detail.status(), StatusCode::OK);
    let detail: Value =
        serde_json::from_slice(&detail.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let movie = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    let video = assets
        .iter()
        .find(|asset| Some(asset.id) == movie.video_asset_id)
        .unwrap();
    assert_eq!(
        detail["video_url"],
        format!("/media/v1/{}", video.storage_key)
    );
    std::fs::set_permissions(roots[0].as_ref(), std::fs::Permissions::from_mode(0o700)).unwrap();
}

// Catches returning a generic filesystem failure or accepting uploads without capacity.
#[tokio::test]
async fn multi_volume_no_capacity_returns_stable_507_without_paths() {
    let db = database().await;
    let root = volume_root(0);
    let mut config = config(root.as_ref());
    config.media_disk_reserve_bytes = u64::MAX;
    let app = app::build(db.clone(), &config).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let movie = draft_movie(&db, None).await;
    let response = app
        .oneshot(multipart_request(
            format!("/api/admin/media/movies/{}/video?version=1", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INSUFFICIENT_STORAGE);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        json!({"error":"media storage is unavailable or full","code":"media_storage_insufficient"})
    );
    assert!(
        media_asset::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .is_empty()
    );
}

// Catches reserving only the observed body length when Content-Length is absent.
#[tokio::test]
async fn multi_volume_missing_content_length_reserves_policy_limit() {
    let db = database().await;
    let root = volume_root(0);
    let mut config = config(root.as_ref());
    config.max_upload_bytes = i64::MAX as u64;
    let app = app::build(db.clone(), &config).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let movie = draft_movie(&db, None).await;
    let response = app
        .clone()
        .oneshot(multipart_request(
            format!("/api/admin/media/movies/{}/video?version=1", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INSUFFICIENT_STORAGE);
    let mut request = multipart_request(
        format!("/api/admin/media/movies/{}/video?version=1", movie.id),
        Some(&cookie),
        Some(&csrf),
        "https://harbor.test",
    );
    use axum::body::HttpBody;
    let length = request.body().size_hint().exact().unwrap().to_string();
    request
        .headers_mut()
        .insert("content-length", length.parse().unwrap());
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
}

// Catches dropping a nonzero-volume asset record while leaving its physical file behind.
#[tokio::test]
async fn multi_volume_delete_rejects_nonzero_assets_without_mutation() {
    let db = database().await;
    let roots = [volume_root(0), volume_root(1)];
    let mut cfg = config(roots[0].as_ref());
    cfg.media_dirs.push(roots[1].as_ref().to_path_buf());
    let app = app::build(db.clone(), &cfg).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let id = Uuid::new_v4();
    let key = format!(
        "poster/{}/{}.png",
        &id.simple().to_string()[..2],
        id.simple()
    );
    std::fs::create_dir_all(roots[1].as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::create_dir_all(roots[0].as_ref().join(&key).parent().unwrap()).unwrap();
    std::fs::write(roots[0].as_ref().join(&key), b"unrelated same-key file").unwrap();
    std::fs::write(roots[1].as_ref().join(&key), PNG).unwrap();
    let asset = media_asset::ActiveModel {
        id: Set(id),
        storage_volume: Set(1),
        storage_key: Set(key.clone()),
        original_name: Set("poster.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(PNG.len() as i64),
        purpose: Set("poster".into()),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(asset.id)).await;
    let response = json_request(
        &app,
        "DELETE",
        &format!("/api/admin/movies/{}", movie.id),
        json!({"version":1}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        movie::Entity::find_by_id(movie.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        media_asset::Entity::find_by_id(asset.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(std::fs::read(roots[1].as_ref().join(&key)).unwrap(), PNG);
    assert_eq!(
        std::fs::read(roots[0].as_ref().join(&key)).unwrap(),
        b"unrelated same-key file"
    );
}

// Catches treating a record with the same key on another volume as ownership of an interrupted upload.
#[tokio::test]
async fn multi_volume_recovery_matches_both_volume_and_key() {
    let db = database().await;
    let roots = [volume_root(0), volume_root(1)];
    let storage = MediaStorageSet::initialize(
        &roots
            .iter()
            .map(|root| root.as_ref().to_path_buf())
            .collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();
    let id = Uuid::new_v4();
    let key = format!(
        "poster/{}/{}.png",
        &id.simple().to_string()[..2],
        id.simple()
    );
    for root in &roots {
        let path = root.as_ref().join(&key);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, PNG).unwrap();
        write_pending_marker(root.as_ref(), id, &key, &path);
    }
    media_asset::ActiveModel {
        id: Set(id),
        storage_volume: Set(0),
        storage_key: Set(key.clone()),
        original_name: Set("poster.png".into()),
        mime_type: Set("image/png".into()),
        byte_size: Set(PNG.len() as i64),
        purpose: Set("poster".into()),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    movie_harbor_api::media::upload::recover_stale_uploads(&db, &storage, Duration::ZERO)
        .await
        .unwrap();
    assert!(roots[0].as_ref().join(&key).is_file());
    assert!(!roots[1].as_ref().join(&key).exists());
    for root in &roots {
        assert_eq!(
            std::fs::read_dir(root.as_ref().join(".incoming"))
                .unwrap()
                .count(),
            0
        );
    }
}

// Catches staging the old key in the new file's volume during a cross-volume replacement.
#[tokio::test]
async fn multi_volume_replacement_removes_only_the_old_recorded_volume_file() {
    let db = database().await;
    let roots = [volume_root(0), volume_root(1)];
    let set = MediaStorageSet::initialize(
        &roots
            .iter()
            .map(|root| root.as_ref().to_path_buf())
            .collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();
    let held = set.reserve_for_upload(1024 * 1024 * 1024).await.unwrap();
    let new_volume = held.volume_id();
    let old_volume = 1 - new_volume;
    let (source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &set,
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(4096),
        source,
    )
    .await
    .unwrap();
    assert_eq!(old.storage_volume, old_volume);
    drop(held);
    let same_key = roots[new_volume as usize].as_ref().join(&old.storage_key);
    std::fs::set_permissions(
        roots[old_volume as usize].as_ref(),
        std::fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    std::fs::create_dir_all(same_key.parent().unwrap()).unwrap();
    std::fs::write(&same_key, b"unrelated").unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let (source, _) = Chunks::new([jpeg()]);
    let new = tokio::time::timeout(
        Duration::from_secs(5),
        replace_attachment(
            &db,
            &set,
            AttachmentTarget::MoviePoster {
                id: movie.id,
                version: 1,
            },
            "new.jpg",
            "image/jpeg",
            &policy(4096),
            source,
        ),
    )
    .await
    .expect("shared lock was reacquired")
    .unwrap();
    std::fs::set_permissions(
        roots[old_volume as usize].as_ref(),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(new.storage_volume, new_volume);
    assert_eq!(std::fs::read(same_key).unwrap(), b"unrelated");
    assert!(
        !roots[old_volume as usize]
            .as_ref()
            .join(&old.storage_key)
            .exists()
    );
    assert!(
        roots[new_volume as usize]
            .as_ref()
            .join(&new.storage_key)
            .is_file()
    );
    assert!(
        media_asset::Entity::find_by_id(old.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        movie::Entity::find_by_id(movie.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .poster_asset_id,
        Some(new.id)
    );
}

// Catches publication scanning other volumes when the recorded volume lacks the file.
#[tokio::test]
async fn multi_volume_publication_never_falls_back_to_a_same_key_in_another_volume() {
    let db = database().await;
    let roots = [volume_root(0), volume_root(1)];
    let set = MediaStorageSet::initialize(
        &roots
            .iter()
            .map(|root| root.as_ref().to_path_buf())
            .collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();
    let (source, _) = Chunks::bytes(valid_mp4());
    let mut asset = store_new_asset(
        &db,
        &set,
        MediaKind::Video,
        "movie.mp4",
        "video/mp4",
        &policy(4096),
        source,
    )
    .await
    .unwrap();
    // The allocator observes a live filesystem; put the publication fixture explicitly
    // on volume 0 so concurrent tests cannot change the intended wrong-volume case.
    if asset.storage_volume == 1 {
        let target = roots[0].as_ref().join(&asset.storage_key);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::rename(roots[1].as_ref().join(&asset.storage_key), target).unwrap();
    }
    asset.storage_volume = 1;
    assert!(!movie_harbor_api::media::is_publishable_asset(
        &set,
        Some(&asset),
        "video",
        &["video/mp4"]
    ));
    asset.storage_volume = 9;
    assert!(!movie_harbor_api::media::is_publishable_asset(
        &set,
        Some(&asset),
        "video",
        &["video/mp4"]
    ));
}
fn volume_root(volume: i32) -> TempRoot {
    let root = TempRoot::new();
    std::fs::write(
        root.as_ref().join(".movie-harbor-volume.json"),
        serde_json::to_vec(&json!({"version": 1, "volume": volume})).unwrap(),
    )
    .unwrap();
    root
}

// Catches accepting an empty set, which could silently leave the application without storage.
#[tokio::test]
async fn allocator_rejects_empty_configuration() {
    assert!(MediaStorageSet::initialize(&[], 0).await.is_err());
}

// Catches accepting duplicated roots, including two names resolving to one directory.
#[tokio::test]
async fn allocator_rejects_duplicate_canonical_roots() {
    let root = volume_root(0);
    let error =
        MediaStorageSet::initialize(&[root.as_ref().to_path_buf(), root.as_ref().join(".")], 0)
            .await
            .err()
            .expect("duplicate roots must fail");
    assert!(error.to_string().contains("volume 1"));
    assert!(!format!("{error:?}").contains(&root.as_ref().display().to_string()));
}

// Catches trusting missing, malformed, reordered or unsupported volume identity files.
#[tokio::test]
async fn allocator_requires_matching_versioned_volume_identity() {
    for marker in [
        None,
        Some("not json"),
        Some(r#"{"version":2,"volume":1}"#),
        Some(r#"{"version":1,"volume":0}"#),
    ] {
        let first = volume_root(0);
        let second = TempRoot::new();
        if let Some(marker) = marker {
            std::fs::write(second.as_ref().join(".movie-harbor-volume.json"), marker).unwrap();
        }
        let error = MediaStorageSet::initialize(
            &[first.as_ref().to_path_buf(), second.as_ref().to_path_buf()],
            0,
        )
        .await
        .err()
        .expect("invalid volume identity must fail");
        assert!(error.to_string().contains("volume 1"));
        assert!(!format!("{error:?}").contains(&second.as_ref().display().to_string()));
    }
}

// Catches probing a reopened root path instead of the already validated directory capability.
#[tokio::test]
async fn allocator_real_capacity_probe_survives_root_path_rename() {
    let root = volume_root(0);
    let set = MediaStorageSet::initialize(&[root.as_ref().to_path_buf()], 0)
        .await
        .unwrap();
    let parent = TempRoot::new();
    let moved = parent.as_ref().join("moved-volume");
    std::fs::rename(root.as_ref(), &moved).unwrap();
    let reservation = set.reserve_for_upload(1).await.unwrap();
    assert_eq!(reservation.volume_id(), 0);
    assert!(matches!(
        set.reserve_for_upload(u64::MAX).await,
        Err(MediaError::InsufficientStorage)
    ));
}

// Catches assigning each volume its own lock or releasing the shared lock before ownership resolves.
#[tokio::test]
async fn allocator_serializes_cross_volume_mutations_until_promoted_file_is_resolved() {
    let roots = [volume_root(0), volume_root(1)];
    let set = MediaStorageSet::initialize(
        &roots
            .iter()
            .map(|root| root.as_ref().to_path_buf())
            .collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();
    let (source, _) = Chunks::new([PNG]);
    let first = set
        .volume(0)
        .unwrap()
        .storage()
        .store(
            Uuid::new_v4(),
            MediaKind::Poster,
            "first.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await
        .unwrap();
    let (source, polls) = Chunks::new([PNG]);
    let second_storage = set.volume(1).unwrap().storage();
    let upload_policy = policy(1024);
    let second = second_storage.store(
        Uuid::new_v4(),
        MediaKind::Poster,
        "second.png",
        "image/png",
        &upload_policy,
        source,
    );
    tokio::pin!(second);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut second)
            .await
            .is_err()
    );
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    drop(first);
    let stored = tokio::time::timeout(Duration::from_secs(2), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read(roots[1].as_ref().join(&stored.storage_key)).unwrap(),
        PNG
    );
}

// Catches buffering the entire body before writing and using the user filename as a disk path.
#[tokio::test]
async fn chunks_are_written_incrementally_to_an_opaque_system_key() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, polls) = Chunks::new([&PNG[..8], &PNG[8..]]);
    let stored = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Poster,
            "cover.png",
            "image/png",
            &policy(1024),
            source.inspect_incoming_before_second(root.as_ref()),
        )
        .await
        .unwrap();

    assert_eq!(polls.load(Ordering::SeqCst), 3);
    assert_eq!(stored.byte_size, PNG.len() as i64);
    assert!(!stored.storage_key.contains("cover"));
    assert_eq!(stored.storage_key.split('/').count(), 3);
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&stored.storage_key))
            .await
            .unwrap(),
        PNG
    );
    let incoming = std::fs::read_dir(root.as_ref().join(".incoming"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(incoming.len(), 1);
    assert!(incoming[0].ends_with(".pending"));
}

// Catches two storage mutations running concurrently inside one storage instance.
#[tokio::test]
async fn storage_mutations_are_serialized_until_the_promoted_file_is_resolved() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let first_storage = storage.clone();
    let first = tokio::spawn(async move {
        first_storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "first.png",
                "image/png",
                &policy(1024),
                BlockingChunks {
                    started: Some(started_tx),
                    release: Some(release_rx),
                    finished: false,
                },
            )
            .await
    });
    started_rx.await.unwrap();

    let (second_source, second_polls) = Chunks::new([PNG]);
    let second_storage = storage.clone();
    let second = tokio::spawn(async move {
        second_storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "second.png",
                "image/png",
                &policy(1024),
                second_source,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(second_polls.load(Ordering::SeqCst), 0);

    release_tx.send(()).unwrap();
    let first_stored = tokio::time::timeout(Duration::from_secs(2), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(second_polls.load(Ordering::SeqCst), 0);
    drop(first_stored);
    tokio::time::timeout(Duration::from_secs(2), second)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

// Catches starting with a media root writable by other OS accounts or a public quarantine.
#[cfg(unix)]
#[tokio::test]
async fn storage_requires_exclusive_write_permissions_and_private_quarantine() {
    let unsafe_root = TempRoot::new();
    std::fs::set_permissions(unsafe_root.as_ref(), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        LocalMediaStorage::initialize(unsafe_root.as_ref())
            .await
            .is_err()
    );

    let safe_root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(safe_root.as_ref())
        .await
        .unwrap();
    let quarantine = storage.root().join(".quarantine");
    let metadata = std::fs::symlink_metadata(quarantine).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
}

// Catches a process crash after a random quarantine claim but before unlink.
#[cfg(unix)]
#[tokio::test]
async fn startup_restores_a_durable_random_quarantine_claim_for_retry() {
    let root = TempRoot::new();
    let resource = Uuid::new_v4();
    let simple = resource.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, PNG).unwrap();
    let metadata = std::fs::metadata(&formal).unwrap();
    let quarantine = root.as_ref().join(".quarantine");
    std::fs::create_dir(&quarantine).unwrap();
    std::fs::set_permissions(&quarantine, std::fs::Permissions::from_mode(0o700)).unwrap();
    let claim_id = Uuid::new_v4().simple().to_string();
    std::fs::rename(&formal, quarantine.join(format!("{claim_id}.data"))).unwrap();
    std::fs::write(
        quarantine.join(format!("{claim_id}.claim")),
        serde_json::to_vec(&json!({
            "version": 1,
            "storage_key": key,
            "device": metadata.dev(),
            "inode": metadata.ino(),
            "byte_size": PNG.len(),
            "checksum_sha256": format!("{:x}", Sha256::digest(PNG)),
        }))
        .unwrap(),
    )
    .unwrap();

    LocalMediaStorage::initialize(root.as_ref()).await.unwrap();

    assert_eq!(std::fs::read(formal).unwrap(), PNG);
    assert!(std::fs::read_dir(quarantine).unwrap().next().is_none());
}

// Catches replacing a destination that appears after a preflight existence check.
#[tokio::test]
async fn promotion_is_atomic_and_never_overwrites_a_collision() {
    let root = TempRoot::new();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::Collision,
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                id,
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.as_ref().join(key)).unwrap(),
        b"collision"
    );
}

// Catches path-based rename following a parent changed to an external symlink mid-operation.
#[cfg(unix)]
#[tokio::test]
async fn promotion_does_not_follow_a_parent_symlink_substituted_during_commit() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::ReplaceParentWithSymlink(outside.as_ref().to_owned()),
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let file_name = format!("{}.png", simple);
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                id,
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(outside.as_ref().join(file_name)).unwrap(),
        b"outside"
    );
}

// Catches promotion renaming an attacker-substituted source symlink after validating another inode.
#[cfg(unix)]
#[tokio::test]
async fn promotion_rejects_a_source_part_replaced_by_an_external_symlink() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    let outside_file = outside.as_ref().join("external.png");
    std::fs::write(&outside_file, PNG).unwrap();
    let hooks = Arc::new(AdversarialHooks {
        root: root.as_ref().to_owned(),
        action: AdversarialAction::ReplaceSourceWithSymlink(outside_file.clone()),
        fired: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);

    assert!(
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                source,
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(outside_file).unwrap(), PNG);
}

// Catches omitting a file/directory fsync or syncing cross-directory rename endpoints out of order.
#[tokio::test]
async fn durable_promotion_syncs_created_parents_source_and_destination_in_order() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(RecordingHooks::default());
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);
    let asset = store_new_asset(
        &db,
        &storage.clone().into(),
        MediaKind::Poster,
        "cover.png",
        "image/png",
        &policy(1024),
        source,
    )
    .await
    .unwrap();
    let parent = asset.storage_key.rsplit_once('/').unwrap().0.to_owned();
    let events = hooks.events.lock().unwrap().clone();

    let find = |predicate: &dyn Fn(&StorageEvent) -> bool| {
        events
            .iter()
            .position(predicate)
            .expect("required durability event")
    };
    let root_sync = find(&|event| event == &StorageEvent::DirectorySynced(String::new()));
    let kind_sync = find(&|event| event == &StorageEvent::DirectorySynced("poster".into()));
    let temp_sync =
        find(&|event| matches!(event, StorageEvent::FileSynced(name) if name.ends_with(".part")));
    let marker_sync = find(
        &|event| matches!(event, StorageEvent::FileSynced(name) if name.ends_with(".pending")),
    );
    let promote = find(&|event| matches!(event, StorageEvent::Promoted(_)));
    let destination_sync = find(&|event| event == &StorageEvent::DirectorySynced(parent.clone()));
    let source_sync_after = events
        .iter()
        .enumerate()
        .skip(promote + 1)
        .find(|(_, event)| *event == &StorageEvent::DirectorySynced(".incoming".into()))
        .map(|(index, _)| index)
        .expect("source directory sync after rename");
    assert!(root_sync < kind_sync && kind_sync < temp_sync);
    assert!(temp_sync < marker_sync && marker_sync < promote);
    assert!(promote < destination_sync && destination_sync < source_sync_after);
}

// Catches cancellation skipping explicit async error cleanup and leaking a part file.
#[tokio::test]
async fn cancelling_an_upload_removes_its_incoming_part_file() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let task_storage = storage.clone();
    let task = tokio::spawn(async move {
        task_storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(1024),
                PausingChunks { first: true },
            )
            .await
    });
    for _ in 0..100 {
        if std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part")
            })
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches an unsafe startup sweep deleting fresh/in-progress files or scanning formal media.
#[tokio::test]
async fn recovery_sweeps_only_stale_incoming_part_files() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let incoming = root.as_ref().join(".incoming");
    let stale = incoming.join(format!("{}.part", Uuid::new_v4().simple()));
    let fresh = incoming.join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&stale, b"stale").unwrap();
    std::fs::write(&fresh, b"fresh").unwrap();
    let stale_file = std::fs::File::open(&stale).unwrap();
    stale_file
        .set_times(
            std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7200)),
        )
        .unwrap();
    let formal = root.as_ref().join("poster/not-a-controlled-file");
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, b"formal").unwrap();

    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::from_secs(3600),
    )
    .await
    .unwrap();

    assert!(!stale.exists());
    assert!(fresh.exists());
    assert!(formal.exists());
}

// Catches one truncated marker aborting startup recovery or preventing safe entries from sweeping.
#[tokio::test]
async fn invalid_recovery_markers_are_retained_without_aborting_the_sweep() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let invalid = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.pending", Uuid::new_v4().simple()));
    let stale_part = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&invalid, b"{truncated").unwrap();
    std::fs::write(&stale_part, b"stale").unwrap();
    make_stale(&invalid);
    make_stale(&stale_part);

    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::ZERO,
    )
    .await
    .unwrap();

    assert!(invalid.exists());
    assert!(!stale_part.exists());
}

// Catches crash-before-promotion recovery deleting an unrelated destination collision.
#[cfg(unix)]
#[tokio::test]
async fn recovery_requires_marker_identity_before_deleting_a_formal_file() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, b"unrelated collision").unwrap();
    let owner = root
        .as_ref()
        .join(".incoming")
        .join(format!("{}.part", Uuid::new_v4().simple()));
    std::fs::write(&owner, PNG).unwrap();
    let marker = write_pending_marker(root.as_ref(), id, &key, &owner);
    make_stale(&marker);

    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::ZERO,
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(formal).unwrap(), b"unrelated collision");
    assert!(
        marker.exists(),
        "unproven marker must remain for investigation"
    );
}

// Catches verifying one inode and later unlinking an attacker-replaced filename.
#[cfg(unix)]
#[tokio::test]
async fn recovery_claim_never_deletes_a_replacement_swapped_at_before_unlink() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(ReplaceAtOwnedUnlink {
        root: root.as_ref().to_owned(),
        replaced: AtomicBool::new(false),
        no_quarantine_data_before_claim: AtomicBool::new(false),
        key: Mutex::new(None),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let simple = id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, PNG).unwrap();
    let marker = write_pending_marker(root.as_ref(), id, &key, &formal);

    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::ZERO,
    )
    .await
    .unwrap();

    assert!(hooks.replaced.load(Ordering::SeqCst));
    assert!(hooks.no_quarantine_data_before_claim.load(Ordering::SeqCst));
    assert_eq!(std::fs::read(&formal).unwrap(), b"UNRELATED REPLACEMENT");
    assert!(formal.with_extension("owned-original").exists());
    assert!(
        marker.exists(),
        "identity mismatch must retain recovery state"
    );
}

// Catches the known-rollback Drop path unlinking a name that was replaced after validation.
#[tokio::test]
async fn rollback_cleanup_uses_the_same_identity_bound_claim_protocol() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(ReplaceAtOwnedUnlink {
        root: root.as_ref().to_owned(),
        replaced: AtomicBool::new(false),
        no_quarantine_data_before_claim: AtomicBool::new(false),
        key: Mutex::new(None),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);

    assert!(matches!(
        replace_attachment(
            &db,
            &storage.clone().into(),
            AttachmentTarget::MoviePoster {
                id: Uuid::new_v4(),
                version: 1,
            },
            "cover.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await,
        Err(MediaError::TargetNotFound)
    ));

    let key = hooks.key.lock().unwrap().clone().unwrap();
    let formal = root.as_ref().join(key);
    assert_eq!(std::fs::read(&formal).unwrap(), b"UNRELATED REPLACEMENT");
    assert!(hooks.no_quarantine_data_before_claim.load(Ordering::SeqCst));
    assert!(formal.with_extension("owned-original").exists());
    assert!(std::fs::read_dir(root.as_ref().join(".incoming"))
        .unwrap()
        .any(|entry| entry.unwrap().path().extension() == Some(std::ffi::OsStr::new("pending"))));
}

// Catches a marker being repointed to a different resource despite matching file metadata.
#[cfg(unix)]
#[tokio::test]
async fn recovery_marker_name_must_match_its_formal_resource_key() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let formal_id = Uuid::new_v4();
    let simple = formal_id.simple().to_string();
    let key = format!("poster/{}/{}.png", &simple[..2], simple);
    let formal = root.as_ref().join(&key);
    std::fs::create_dir_all(formal.parent().unwrap()).unwrap();
    std::fs::write(&formal, PNG).unwrap();
    let marker = write_pending_marker(root.as_ref(), Uuid::new_v4(), &key, &formal);
    make_stale(&marker);

    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::ZERO,
    )
    .await
    .unwrap();

    assert!(formal.exists());
    assert!(marker.exists());
}

// Catches a DB failure plus cleanup failure silently leaking a promoted formal file.
#[tokio::test]
async fn failed_post_promotion_database_path_is_recoverable_on_startup() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(FailFirstUnlink {
        failed: AtomicBool::new(false),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks)
        .await
        .unwrap();
    let (source, _) = Chunks::new([PNG]);
    assert!(matches!(
        replace_attachment(
            &db,
            &storage.clone().into(),
            AttachmentTarget::MoviePoster {
                id: Uuid::new_v4(),
                version: 1,
            },
            "cover.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await,
        Err(MediaError::TargetNotFound)
    ));
    assert!(
        count_files(root.as_ref()) >= 2,
        "formal file and recovery marker remain"
    );

    let recovered = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &recovered.clone().into(),
        Duration::from_secs(0),
    )
    .await
    .unwrap();
    assert_eq!(count_files(root.as_ref()), 0);
}

// Catches cancellation after an autocommit reached PostgreSQL deleting its committed file.
#[tokio::test]
async fn cancellation_after_asset_insert_commit_preserves_file_for_reconciliation() {
    let db = database().await;
    let root = TempRoot::new();
    let hooks = Arc::new(PauseAfterDatabaseCommit {
        commits: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let task_db = db.clone();
    let task_storage = storage.clone();
    let (source, _) = Chunks::new([PNG]);
    let task = tokio::spawn(async move {
        store_new_asset(
            &task_db,
            &task_storage.clone().into(),
            MediaKind::Poster,
            "cover.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await
    });
    while hooks.commits.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let asset = media_asset::Entity::find().one(&db).await.unwrap().unwrap();
    assert!(root.as_ref().join(&asset.storage_key).is_file());
    assert!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".pending"))
    );
    movie_harbor_api::media::upload::recover_stale_uploads(
        &db,
        &storage.clone().into(),
        Duration::ZERO,
    )
    .await
    .unwrap();
    assert!(root.as_ref().join(asset.storage_key).is_file());
}

// Catches cancellation after replacement commit deleting the newly referenced formal file.
#[tokio::test]
async fn cancellation_after_replacement_commit_preserves_new_reference_and_file() {
    let db = database().await;
    let root = TempRoot::new();
    let base_storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &base_storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let movie_id = movie.id;
    let hooks = Arc::new(PauseAfterDatabaseCommit {
        commits: AtomicUsize::new(0),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();
    let task_db = db.clone();
    let task_storage = storage.clone();
    let (source, _) = Chunks::new([PNG]);
    let task = tokio::spawn(async move {
        replace_attachment(
            &task_db,
            &task_storage.clone().into(),
            AttachmentTarget::MoviePoster {
                id: movie_id,
                version: 1,
            },
            "new.png",
            "image/png",
            &policy(1024),
            source,
        )
        .await
    });
    while hooks.commits.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let updated = movie::Entity::find_by_id(movie_id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    let new_id = updated.poster_asset_id.unwrap();
    assert_ne!(new_id, old.id);
    let new_asset = media_asset::Entity::find_by_id(new_id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert!(root.as_ref().join(new_asset.storage_key).is_file());
}

// Catches trusting filenames, declared MIME, extensions, or accepting unsupported formats.
#[tokio::test]
async fn traversal_spoofed_mime_and_unsupported_types_are_rejected() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();

    for name in ["../cover.png", "folder/cover.png", "..\\cover.png"] {
        let (source, _) = Chunks::new([PNG]);
        assert!(matches!(
            storage
                .store(
                    Uuid::new_v4(),
                    MediaKind::Poster,
                    name,
                    "image/png",
                    &policy(1024),
                    source
                )
                .await,
            Err(MediaError::InvalidFileName)
        ));
    }

    for (kind, name, mime, bytes) in [
        (MediaKind::Poster, "cover.png", "image/png", jpeg()),
        (MediaKind::Poster, "cover.jpg", "image/jpeg", PNG),
        (
            MediaKind::Poster,
            "cover.gif",
            "image/gif",
            b"GIF89a".as_slice(),
        ),
        (
            MediaKind::Video,
            "movie.ogv",
            "video/ogg",
            b"OggS\x00\x02movie-harbor-video".as_slice(),
        ),
        (MediaKind::Video, "movie.mp4", "video/mp4", PNG),
    ] {
        let (source, _) = Chunks::new([bytes]);
        assert!(
            storage
                .store(Uuid::new_v4(), kind, name, mime, &policy(1024), source)
                .await
                .is_err()
        );
    }
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches accepting a forged/truncated magic prefix instead of a complete playable container.
#[tokio::test]
async fn structured_validation_accepts_valid_minimal_files_and_rejects_forged_containers() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy = UploadPolicy::new(1024 * 1024, ["video/mp4", "video/webm"]).unwrap();

    for (kind, name, mime, bytes) in [
        (MediaKind::Poster, "valid.png", "image/png", PNG.to_vec()),
        (
            MediaKind::Poster,
            "valid.jpg",
            "image/jpeg",
            jpeg().to_vec(),
        ),
        (MediaKind::Poster, "valid.webp", "image/webp", valid_webp()),
        (MediaKind::Video, "valid.mp4", "video/mp4", valid_mp4()),
        (MediaKind::Video, "valid.webm", "video/webm", valid_webm()),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        storage
            .store(Uuid::new_v4(), kind, name, mime, &video_policy, source)
            .await
            .unwrap_or_else(|error| panic!("valid fixture {name} rejected: {error}"));
    }

    let (unsupported_ogg, _) = Chunks::bytes(valid_ogg_video());
    assert!(matches!(
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Video,
                "formerly-valid.ogv",
                "video/ogg",
                &video_policy,
                unsupported_ogg,
            )
            .await,
        Err(MediaError::UnsupportedType)
    ));

    let audio_ogg = [ogg_page(2, 0, 2, b"\x01vorbis\0"), ogg_page(2, 1, 0, b"\0")].concat();
    let mut invalid_avcc = valid_mp4();
    let avcc = invalid_avcc
        .windows(4)
        .position(|window| window == b"avcC")
        .unwrap();
    invalid_avcc[avcc + 9] &= 0xe0;
    let mut invalid_sample_offset = valid_mp4();
    let stco = invalid_sample_offset
        .windows(4)
        .position(|window| window == b"stco")
        .unwrap();
    invalid_sample_offset[stco + 12..stco + 16].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut mismatched_webm_track = structured_webm();
    let block_track = mismatched_webm_track
        .windows(3)
        .rposition(|window| window == [0xa3, 0x85, 0x81])
        .unwrap()
        + 2;
    mismatched_webm_track[block_track] = 0x82;
    let mut identification = vec![0; 42];
    identification[..7].copy_from_slice(b"\x80theora");
    identification[7..10].copy_from_slice(&[3, 2, 1]);
    identification[10..12].copy_from_slice(&1_u16.to_be_bytes());
    identification[12..14].copy_from_slice(&1_u16.to_be_bytes());
    let bare_theora_headers = [
        ogg_page(3, 0, 2, &identification),
        ogg_page(3, 1, 0, b"\x81theora"),
        ogg_page(3, 2, 0, b"\x82theora"),
        ogg_page(3, 3, 0, b"\0"),
    ]
    .concat();
    for (kind, name, mime, bytes) in [
        (
            MediaKind::Poster,
            "forged.png",
            "image/png",
            b"\x89PNG\r\n\x1a\nnot-a-png".to_vec(),
        ),
        (
            MediaKind::Poster,
            "truncated.jpg",
            "image/jpeg",
            b"\xff\xd8\xff\xe0\0\x10".to_vec(),
        ),
        (
            MediaKind::Poster,
            "forged.webp",
            "image/webp",
            b"RIFF\x04\0\0\0WEBP".to_vec(),
        ),
        (
            MediaKind::Video,
            "magic-only.mp4",
            "video/mp4",
            b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2".to_vec(),
        ),
        (
            MediaKind::Video,
            "unmapped-sample.mp4",
            "video/mp4",
            incomplete_mp4(),
        ),
        (
            MediaKind::Video,
            "invalid-avcc.mp4",
            "video/mp4",
            invalid_avcc,
        ),
        (
            MediaKind::Video,
            "invalid-offset.mp4",
            "video/mp4",
            invalid_sample_offset,
        ),
        (
            MediaKind::Video,
            "truncated.webm",
            "video/webm",
            b"\x1a\x45\xdf\xa3\x84webm".to_vec(),
        ),
        (
            MediaKind::Video,
            "wrong-track.webm",
            "video/webm",
            mismatched_webm_track,
        ),
        (MediaKind::Video, "audio.ogv", "video/ogg", audio_ogg),
        (
            MediaKind::Video,
            "bare-headers.ogv",
            "video/ogg",
            bare_theora_headers,
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        assert!(
            storage
                .store(Uuid::new_v4(), kind, name, mime, &video_policy, source,)
                .await
                .is_err(),
            "forged fixture {name} was accepted"
        );
    }
}

// Catches rejecting real browser-playable MP4s merely because they contain AAC or High avcC data.
#[tokio::test]
async fn mp4_validation_accepts_ffmpeg_baseline_with_aac_and_high_profile() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy = UploadPolicy::new(1024 * 1024, ["video/mp4"]).unwrap();
    for (name, bytes) in [
        ("baseline-aac.mp4", ffmpeg_baseline_h264_aac_mp4()),
        ("high.mp4", ffmpeg_high_h264_mp4()),
        (
            "high-without-extensions.mp4",
            ffmpeg_high_h264_mp4_without_avcc_extensions(),
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Video,
                name,
                "video/mp4",
                &video_policy,
                source,
            )
            .await
            .unwrap_or_else(|error| panic!("ffmpeg fixture {name} rejected: {error}"));
    }
}

// Catches rejecting structurally valid HEVC MP4 video sample entries.
#[tokio::test]
async fn mp4_validation_accepts_hvc1_and_hev1_hevc() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy = UploadPolicy::new(1024 * 1024, ["video/mp4"]).unwrap();
    let mut hev1 = HEVC_HVC1_MP4.to_vec();
    let sample_entry = hev1
        .windows(4)
        .position(|window| window == b"hvc1")
        .expect("fixture must contain an hvc1 sample entry");
    assert_eq!(
        hev1.windows(4).filter(|window| *window == b"hvc1").count(),
        1,
        "fixture must contain exactly one hvc1 sample entry",
    );
    hev1[sample_entry..sample_entry + 4].copy_from_slice(b"hev1");

    for (name, bytes) in [("hvc1.mp4", HEVC_HVC1_MP4.to_vec()), ("hev1.mp4", hev1)] {
        let (source, _) = Chunks::bytes(bytes);
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Video,
                name,
                "video/mp4",
                &video_policy,
                source,
            )
            .await
            .unwrap_or_else(|error| panic!("HEVC fixture {name} rejected: {error:?}"));
    }
}

// Catches rejecting an otherwise unchanged real HEVC fixture when temporal scalability is unknown.
#[tokio::test]
async fn hevc_hvc1_upload_accepts_unknown_temporal_layers() {
    assert_hevc_upload_accepts_unknown_temporal_layers(b"hvc1").await;
}

#[tokio::test]
async fn hevc_hev1_upload_accepts_unknown_temporal_layers() {
    assert_hevc_upload_accepts_unknown_temporal_layers(b"hev1").await;
}

async fn assert_hevc_upload_accepts_unknown_temporal_layers(sample_entry: &[u8; 4]) {
    let mut bytes = HEVC_HVC1_MP4.to_vec();
    let hvcc = bytes
        .windows(4)
        .position(|window| window == b"hvcC")
        .expect("fixture must contain hvcC");
    assert_eq!(
        bytes.windows(4).filter(|window| *window == b"hvcC").count(),
        1
    );
    let temporal_layers = hvcc + 4 + 21;
    assert_ne!(bytes[temporal_layers] & 0x38, 0);
    bytes[temporal_layers] &= !0x38;

    let entry = bytes
        .windows(4)
        .position(|window| window == b"hvc1")
        .expect("fixture must contain an hvc1 sample entry");
    assert_eq!(
        bytes.windows(4).filter(|window| *window == b"hvc1").count(),
        1
    );
    bytes[entry..entry + 4].copy_from_slice(sample_entry);

    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy = UploadPolicy::new(1024 * 1024, ["video/mp4"]).unwrap();
    let (source, _) = Chunks::bytes(bytes.clone());
    let stored = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Video,
            "unknown-temporal-layers.mp4",
            "video/mp4",
            &video_policy,
            source,
        )
        .await
        .unwrap_or_else(|error| panic!("HEVC {sample_entry:?} fixture rejected: {error:?}"));
    assert_eq!(
        tokio::fs::read(root.as_ref().join(&stored.storage_key))
            .await
            .unwrap(),
        bytes,
    );
}

fn shift_mp4_chunk_offsets_after_removal(
    bytes: &mut [u8],
    removed_start: usize,
    removed_length: usize,
) {
    let boxes = bytes
        .windows(4)
        .enumerate()
        .filter_map(|(index, kind)| match kind {
            b"stco" => Some((index, 4_usize)),
            b"co64" => Some((index, 8_usize)),
            _ => None,
        })
        .collect::<Vec<_>>();
    for (box_type, width) in boxes {
        let box_size = u32::from_be_bytes(bytes[box_type - 4..box_type].try_into().unwrap());
        let entry_count =
            u32::from_be_bytes(bytes[box_type + 8..box_type + 12].try_into().unwrap()) as usize;
        assert!(
            16 + entry_count * width <= box_size as usize,
            "fixture contains an invalid chunk offset box",
        );
        let mut cursor = box_type + 12;
        for _ in 0..entry_count {
            let offset = if width == 4 {
                u64::from(u32::from_be_bytes(
                    bytes[cursor..cursor + width].try_into().unwrap(),
                ))
            } else {
                u64::from_be_bytes(bytes[cursor..cursor + width].try_into().unwrap())
            };
            let shifted = if offset >= (removed_start + removed_length) as u64 {
                offset
                    .checked_sub(removed_length as u64)
                    .expect("chunk offset must not underflow")
            } else {
                assert!(
                    offset <= removed_start as u64,
                    "chunk offset must not point inside removed configuration data",
                );
                offset
            };
            if width == 4 {
                bytes[cursor..cursor + width].copy_from_slice(
                    &u32::try_from(shifted)
                        .expect("stco entry must stay within u32")
                        .to_be_bytes(),
                );
            } else {
                bytes[cursor..cursor + width].copy_from_slice(&shifted.to_be_bytes());
            }
            cursor += width;
        }
    }
}

fn remove_hevc_configuration_array(mut bytes: Vec<u8>, removed_type: u8) -> Vec<u8> {
    let hvcc = bytes
        .windows(4)
        .position(|window| window == b"hvcC")
        .expect("fixture must contain hvcC");
    let box_size = u32::from_be_bytes(bytes[hvcc - 4..hvcc].try_into().unwrap()) as usize;
    let payload_start = hvcc + 4;
    let payload_end = hvcc - 4 + box_size;
    let mut cursor = payload_start + 23;
    for _ in 0..bytes[payload_start + 22] {
        let array_header = cursor;
        let nal_type = bytes[array_header] & 0x3f;
        let nal_count = usize::from(u16::from_be_bytes(
            bytes[array_header + 1..array_header + 3]
                .try_into()
                .unwrap(),
        ));
        cursor += 3;
        for _ in 0..nal_count {
            let nal_length = usize::from(u16::from_be_bytes(
                bytes[cursor..cursor + 2].try_into().unwrap(),
            ));
            cursor += 2;
            cursor += nal_length;
        }
        if nal_type == removed_type {
            assert!(cursor <= payload_end);
            let removed_length = cursor - array_header;
            bytes[payload_start + 22] -= 1;
            for index in 4..=hvcc {
                if [
                    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"hvc1", b"hvcC",
                ]
                .iter()
                .any(|kind| bytes[index..index + 4] == **kind)
                {
                    let size = u32::from_be_bytes(bytes[index - 4..index].try_into().unwrap());
                    if index - 4 + size as usize > hvcc {
                        bytes[index - 4..index]
                            .copy_from_slice(&(size - removed_length as u32).to_be_bytes());
                    }
                }
            }
            shift_mp4_chunk_offsets_after_removal(&mut bytes, array_header, removed_length);
            bytes.drain(array_header..cursor);
            let stco = bytes
                .windows(4)
                .position(|window| window == b"stco")
                .expect("fixture must contain stco");
            let first_chunk_offset =
                u32::from_be_bytes(bytes[stco + 12..stco + 16].try_into().unwrap()) as usize;
            let mdat_payload = bytes
                .windows(4)
                .position(|window| window == b"mdat")
                .expect("fixture must contain mdat")
                + 4;
            assert_eq!(first_chunk_offset, mdat_payload);
            return bytes;
        }
    }
    panic!("fixture does not contain HEVC NAL array type {removed_type}");
}

async fn assert_hevc_fixture_rejected(name: &str, bytes: Vec<u8>) {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, _) = Chunks::bytes(bytes);
    let result = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Video,
            name,
            "video/mp4",
            &policy(1024 * 1024),
            source,
        )
        .await;
    assert!(
        matches!(result, Err(MediaError::ContentMismatch)),
        "malformed HEVC fixture {name} was not rejected: {result:?}",
    );
}

// Catches accepting truncated configuration or HEVC tracks without every required parameter set.
#[tokio::test]
async fn hevc_configuration_requires_complete_hvcc_vps_sps_and_pps() {
    let mut truncated_hvcc = HEVC_HVC1_MP4.to_vec();
    let hvcc = truncated_hvcc
        .windows(4)
        .position(|window| window == b"hvcC")
        .unwrap();
    truncated_hvcc[hvcc - 4..hvcc].copy_from_slice(&30_u32.to_be_bytes());

    assert_hevc_fixture_rejected("truncated-hvcc.mp4", truncated_hvcc).await;
    for missing_type in [32, 33, 34] {
        assert_hevc_fixture_rejected(
            &format!("missing-{missing_type}.mp4"),
            remove_hevc_configuration_array(HEVC_HVC1_MP4.to_vec(), missing_type),
        )
        .await;
    }
}

// Catches trusting HEVC sample sizes without validating each length-prefixed NAL header.
#[tokio::test]
async fn hevc_samples_reject_length_overflow_and_invalid_nal_headers() {
    let mdat_payload = HEVC_HVC1_MP4
        .windows(4)
        .position(|window| window == b"mdat")
        .unwrap()
        + 4;

    let mut length_overflow = HEVC_HVC1_MP4.to_vec();
    length_overflow[mdat_payload..mdat_payload + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_hevc_fixture_rejected("nal-length-overflow.mp4", length_overflow).await;

    let mut forbidden = HEVC_HVC1_MP4.to_vec();
    forbidden[mdat_payload + 4] |= 0x80;
    assert_hevc_fixture_rejected("forbidden-nal-header.mp4", forbidden).await;

    let mut missing_temporal_id = HEVC_HVC1_MP4.to_vec();
    missing_temporal_id[mdat_payload + 5] &= 0xf8;
    assert_hevc_fixture_rejected("missing-temporal-id.mp4", missing_temporal_id).await;

    let mut no_vcl = HEVC_HVC1_MP4.to_vec();
    no_vcl[mdat_payload + 4] = 32 << 1;
    assert_hevc_fixture_rejected("sample-without-vcl.mp4", no_vcl).await;
}

// Catches broadening MP4 acceptance to unimplemented video codecs.
#[tokio::test]
async fn hevc_support_does_not_accept_av1_sample_entries() {
    let mut av1 = HEVC_HVC1_MP4.to_vec();
    let sample_entry = av1.windows(4).position(|window| window == b"hvc1").unwrap();
    av1[sample_entry..sample_entry + 4].copy_from_slice(b"av01");
    assert_hevc_fixture_rejected("unsupported-av1.mp4", av1).await;
}

// Catches trusting only H.264 NAL types or allocating per an untrusted fixed sample count.
#[tokio::test]
async fn mp4_validation_rejects_forbidden_nals_and_declared_count_amplification() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let video_policy = UploadPolicy::new(1024 * 1024, ["video/mp4"]).unwrap();
    let mut forbidden = valid_mp4();
    let mdat = forbidden
        .windows(4)
        .position(|bytes| bytes == b"mdat")
        .unwrap()
        + 4;
    let mut cursor = mdat;
    while cursor < forbidden.len() {
        let length = u32::from_be_bytes(forbidden[cursor..cursor + 4].try_into().unwrap()) as usize;
        forbidden[cursor + 4] |= 0x80;
        cursor += 4 + length;
    }
    for (name, bytes) in [
        ("forbidden.mp4", forbidden),
        ("count-bomb.mp4", declared_sample_count_bomb()),
        (
            "corrupt-metadata.mp4",
            corrupt_ffmpeg_high_h264_mp4_fixture(),
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            storage.store(
                Uuid::new_v4(),
                MediaKind::Video,
                name,
                "video/mp4",
                &video_policy,
                source,
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("parser did not reject {name} within its bounded budget"));
        assert!(result.is_err(), "malformed fixture {name} was accepted");
    }
}

// Catches accepting parameter sets that expose only IDs but omit required H.264 RBSP syntax.
#[tokio::test]
async fn mp4_validation_rejects_id_only_sps_and_pps() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let mut bytes = ffmpeg_high_h264_mp4();
    let avcc = bytes.windows(4).position(|bytes| bytes == b"avcC").unwrap();
    let sps_length = usize::from(u16::from_be_bytes(
        bytes[avcc + 10..avcc + 12].try_into().unwrap(),
    ));
    bytes[avcc + 16..avcc + 12 + sps_length].fill(0);
    bytes[avcc + 16] = 0x80;
    let pps_length_position = avcc + 12 + sps_length + 1;
    let pps_length = usize::from(u16::from_be_bytes(
        bytes[pps_length_position..pps_length_position + 2]
            .try_into()
            .unwrap(),
    ));
    bytes[pps_length_position + 3..pps_length_position + 2 + pps_length].fill(0);
    bytes[pps_length_position + 3] = 0xc0;
    let (source, _) = Chunks::bytes(bytes);

    let result = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Video,
            "id-only.mp4",
            "video/mp4",
            &policy(1024 * 1024),
            source,
        )
        .await;

    assert!(result.is_err());
}

// Catches one valid SPS masking a second individually-invalid forbidden-bit SPS.
#[tokio::test]
async fn mp4_validation_rejects_an_additional_forbidden_sps() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let mut bytes = ffmpeg_high_h264_mp4();
    let avcc = bytes.windows(4).position(|bytes| bytes == b"avcC").unwrap();
    let sps_length = usize::from(u16::from_be_bytes(
        bytes[avcc + 10..avcc + 12].try_into().unwrap(),
    ));
    let mut extra = bytes[avcc + 10..avcc + 12 + sps_length].to_vec();
    extra[2] |= 0x80;
    for index in 4..=avcc {
        if [
            b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc1", b"avcC",
        ]
        .iter()
        .any(|kind| bytes[index..index + 4] == **kind)
        {
            let size = u32::from_be_bytes(bytes[index - 4..index].try_into().unwrap());
            if index - 4 + size as usize > avcc {
                bytes[index - 4..index].copy_from_slice(&(size + extra.len() as u32).to_be_bytes());
            }
        }
    }
    bytes[avcc + 9] += 1;
    bytes.splice(avcc + 12 + sps_length..avcc + 12 + sps_length, extra);
    let (source, _) = Chunks::bytes(bytes);

    let result = storage
        .store(
            Uuid::new_v4(),
            MediaKind::Video,
            "extra-forbidden-sps.mp4",
            "video/mp4",
            &policy(1024 * 1024),
            source,
        )
        .await;

    assert!(result.is_err());
}

fn unsigned_exp_golomb_bits(value: u32) -> String {
    let encoded = format!("{:b}", u64::from(value) + 1);
    format!("{}{}", "0".repeat(encoded.len() - 1), encoded)
}

fn pack_h264_rbsp(mut bits: String) -> Vec<u8> {
    bits.push('1');
    while !bits.len().is_multiple_of(8) {
        bits.push('0');
    }
    let raw = bits
        .as_bytes()
        .chunks(8)
        .map(|byte| {
            byte.iter()
                .fold(0_u8, |value, bit| (value << 1) | (bit - b'0'))
        })
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut zeroes = 0;
    for byte in raw {
        if zeroes >= 2 && byte <= 3 {
            result.push(3);
            zeroes = 0;
        }
        result.push(byte);
        zeroes = if byte == 0 { zeroes + 1 } else { 0 };
    }
    result
}

fn extreme_dimension_avcc() -> Vec<u8> {
    let mut sps = vec![0x67, 66, 0, 30];
    let mut sps_bits = [0, 0, 0, 0, 0].map(unsigned_exp_golomb_bits).concat();
    sps_bits.push('0');
    sps_bits += &unsigned_exp_golomb_bits(65_535);
    sps_bits += &unsigned_exp_golomb_bits(65_535);
    sps_bits += "1100";
    sps.extend(pack_h264_rbsp(sps_bits));

    let mut pps = vec![0x68];
    let mut pps_bits = unsigned_exp_golomb_bits(0) + &unsigned_exp_golomb_bits(0) + "00";
    pps_bits += &unsigned_exp_golomb_bits(1);
    pps_bits += &unsigned_exp_golomb_bits(0);
    pps_bits += &unsigned_exp_golomb_bits(0);
    pps.extend(pack_h264_rbsp(pps_bits));

    let mut payload = vec![1, 66, 0, 30, 0xff, 0xe1];
    payload.extend((sps.len() as u16).to_be_bytes());
    payload.extend(sps);
    payload.push(1);
    payload.extend((pps.len() as u16).to_be_bytes());
    payload.extend(pps);
    payload
}

fn dimension_slice_group_avcc(width: u32, height: u32, map_type: u32) -> Vec<u8> {
    let mut sps = vec![0x67, 66, 0, 30];
    let mut sps_bits = [0, 0, 0, 0, 0].map(unsigned_exp_golomb_bits).concat();
    sps_bits.push('0');
    sps_bits += &unsigned_exp_golomb_bits(width);
    sps_bits += &unsigned_exp_golomb_bits(height);
    sps_bits += "1100";
    sps.extend(pack_h264_rbsp(sps_bits));

    let mut pps = vec![0x68];
    let mut pps_bits = unsigned_exp_golomb_bits(0) + &unsigned_exp_golomb_bits(0) + "00";
    pps_bits += &unsigned_exp_golomb_bits(1);
    pps_bits += &unsigned_exp_golomb_bits(map_type);
    match map_type {
        0 => {
            pps_bits += &unsigned_exp_golomb_bits(0);
            pps_bits += &unsigned_exp_golomb_bits(0);
        }
        1 => {}
        2 => {
            pps_bits += &unsigned_exp_golomb_bits(0);
            pps_bits += &unsigned_exp_golomb_bits(0);
        }
        3..=5 => {
            pps_bits.push('0');
            pps_bits += &unsigned_exp_golomb_bits(0);
        }
        6 => pps_bits += &unsigned_exp_golomb_bits(u32::MAX),
        _ => unreachable!(),
    }
    pps.extend(pack_h264_rbsp(pps_bits));

    let mut payload = vec![1, 66, 0, 30, 0xff, 0xe1];
    payload.extend((sps.len() as u16).to_be_bytes());
    payload.extend(sps);
    payload.push(1);
    payload.extend((pps.len() as u16).to_be_bytes());
    payload.extend(pps);
    payload
}

fn replace_mp4_avcc(mut bytes: Vec<u8>, replacement: Vec<u8>) -> Vec<u8> {
    let avcc = bytes.windows(4).position(|bytes| bytes == b"avcC").unwrap();
    let old_size = u32::from_be_bytes(bytes[avcc - 4..avcc].try_into().unwrap()) as usize;
    let delta = (replacement.len() + 8) as i64 - old_size as i64;
    for index in 4..=avcc {
        if [
            b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc1", b"avcC",
        ]
        .iter()
        .any(|kind| bytes[index..index + 4] == **kind)
        {
            let size = u32::from_be_bytes(bytes[index - 4..index].try_into().unwrap());
            if index - 4 + size as usize > avcc {
                bytes[index - 4..index]
                    .copy_from_slice(&((i64::from(size) + delta) as u32).to_be_bytes());
            }
        }
    }
    bytes.splice(avcc + 4..avcc - 4 + old_size, replacement);
    bytes
}

// Catches unbounded SPS dimensions overflowing inside dependent PPS slice-group parsing.
#[tokio::test]
async fn extreme_sps_dimensions_never_panic_during_pps_parsing() {
    let bytes = replace_mp4_avcc(ffmpeg_high_h264_mp4(), extreme_dimension_avcc());
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, _) = Chunks::bytes(bytes);

    let result = tokio::spawn(async move {
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Video,
                "extreme.mp4",
                "video/mp4",
                &policy(1_000_000),
                source,
            )
            .await
    })
    .await;

    assert!(result.is_ok(), "upload task panicked: {result:?}");
    assert!(result.unwrap().is_err());
}

// Exercises all PPS slice-group branches with extreme Exp-Golomb dimensions and values.
#[tokio::test]
async fn extreme_h264_dimension_and_slice_group_variants_are_bounded_and_never_panic() {
    for dimension in [512, 65_535, u32::MAX] {
        for map_type in 0..=6 {
            let bytes = replace_mp4_avcc(
                ffmpeg_high_h264_mp4(),
                dimension_slice_group_avcc(dimension, dimension, map_type),
            );
            let root = TempRoot::new();
            let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
            let (source, _) = Chunks::bytes(bytes);
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                tokio::spawn(async move {
                    storage
                        .store(
                            Uuid::new_v4(),
                            MediaKind::Video,
                            "extreme.mp4",
                            "video/mp4",
                            &policy(1_000_000),
                            source,
                        )
                        .await
                }),
            )
            .await
            .unwrap_or_else(|_| panic!("dimension {dimension}, map type {map_type} timed out"));
            assert!(
                result.is_ok(),
                "dimension {dimension}, map type {map_type} panicked: {result:?}"
            );
            assert!(result.unwrap().is_err());
        }
    }
}

// Catches unchecked MP4 slicing and parser panics on arbitrary short malformed inputs.
#[tokio::test]
async fn malformed_media_never_panics_and_the_17_byte_mp4_is_rejected() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let mut cases = vec![(
        "panic.mp4",
        "video/mp4",
        [b"\0\0\0\x11ftyp".as_slice(), &[0; 9]].concat(),
    )];
    for length in 0..128_usize {
        let bytes = (0..length)
            .map(|index| (index.wrapping_mul(73) ^ length) as u8)
            .collect::<Vec<_>>();
        for (name, mime) in [
            ("fuzz.mp4", "video/mp4"),
            ("fuzz.webm", "video/webm"),
            ("fuzz.ogv", "video/ogg"),
            ("fuzz.png", "image/png"),
            ("fuzz.jpg", "image/jpeg"),
            ("fuzz.webp", "image/webp"),
        ] {
            cases.push((name, mime, bytes.clone()));
        }
    }
    let fuzz_policy = UploadPolicy::new(1024, ["video/mp4", "video/webm"]).unwrap();
    for (name, mime, bytes) in cases {
        let task_storage = storage.clone();
        let task_policy = fuzz_policy.clone();
        let (source, _) = Chunks::bytes(bytes);
        let joined = tokio::spawn(async move {
            task_storage
                .store(
                    Uuid::new_v4(),
                    if mime.starts_with("image/") {
                        MediaKind::Poster
                    } else {
                        MediaKind::Video
                    },
                    name,
                    mime,
                    &task_policy,
                    source,
                )
                .await
        })
        .await;
        assert!(joined.is_ok(), "parser panicked for malformed input");
        assert!(joined.unwrap().is_err());
    }
}

// Catches enforcing only a Content-Length header or polling/buffering after the byte limit is known exceeded.
#[tokio::test]
async fn byte_limit_is_enforced_while_streaming_and_stops_polling() {
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (source, polls) = Chunks::new([&PNG[..8], &PNG[8..16], &PNG[16..]]);
    assert!(matches!(
        storage
            .store(
                Uuid::new_v4(),
                MediaKind::Poster,
                "cover.png",
                "image/png",
                &policy(12),
                source
            )
            .await,
        Err(MediaError::TooLarge)
    ));
    assert_eq!(polls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .count(),
        0
    );
}

// Catches a failed old-file stage switching the reference or leaking the promoted replacement.
#[tokio::test]
async fn failed_replacement_preserves_old_reference_and_removes_new_artifact() {
    let db = database().await;
    let root = TempRoot::new();
    let base_storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &base_storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(FailFirstStage {
            failed: AtomicBool::new(false),
        }),
    )
    .await
    .unwrap();

    let (new_source, _) = Chunks::new([jpeg()]);
    let error = replace_attachment(
        &db,
        &storage.clone().into(),
        AttachmentTarget::MoviePoster {
            id: movie.id,
            version: 1,
        },
        "new.jpg",
        "image/jpeg",
        &policy(1024),
        new_source,
    )
    .await
    .unwrap_err();
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        response,
        json!({"error":"media replacement failed","code":"media_replace_failed"})
    );

    let unchanged = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.poster_asset_id, Some(old.id));
    assert!(only_file(root.as_ref(), &old.storage_key).await);
    assert_eq!(media_asset::Entity::find().all(&db).await.unwrap().len(), 1);
    assert_eq!(count_files(root.as_ref()), 1);
}

// Catches a post-commit registration failure being reported as if the old reference survived.
#[tokio::test]
async fn replacement_registration_failure_reports_committed_state() {
    let db = database().await;
    let root = TempRoot::new();
    let base_storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &base_storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let storage = LocalMediaStorage::initialize_with_hooks(
        root.as_ref(),
        Arc::new(FailIncomingSyncAfterCommit {
            committed: AtomicBool::new(false),
        }),
    )
    .await
    .unwrap();

    let (new_source, _) = Chunks::new([jpeg()]);
    let error = replace_attachment(
        &db,
        &storage.clone().into(),
        AttachmentTarget::MoviePoster {
            id: movie.id,
            version: 1,
        },
        "new.jpg",
        "image/jpeg",
        &policy(1024),
        new_source,
    )
    .await
    .unwrap_err();
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        response,
        json!({"error":"media replacement finalization failed","code":"media_replace_finalization_failed"})
    );
    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(updated.poster_asset_id, Some(old.id));
    assert!(
        media_asset::Entity::find_by_id(old.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        std::fs::read_dir(root.as_ref().join(".operations"))
            .unwrap()
            .next()
            .is_some(),
        "the old file removal manifest remains for startup recovery"
    );
}

// Catches a database commit failure leaving the old file staged or the new file registered.
#[tokio::test]
async fn replacement_commit_failure_restores_old_file_and_removes_new_artifact() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    db.execute_unprepared(
        "CREATE FUNCTION reject_replaced_asset_delete() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN RAISE EXCEPTION 'forced deferred replacement failure'; END $$; \
         CREATE CONSTRAINT TRIGGER reject_replaced_asset_delete \
         AFTER DELETE ON media_asset DEFERRABLE INITIALLY DEFERRED \
         FOR EACH ROW EXECUTE FUNCTION reject_replaced_asset_delete()",
    )
    .await
    .unwrap();

    let (new_source, _) = Chunks::new([jpeg()]);
    let error = replace_attachment(
        &db,
        &storage.clone().into(),
        AttachmentTarget::MoviePoster {
            id: movie.id,
            version: 1,
        },
        "new.jpg",
        "image/jpeg",
        &policy(1024),
        new_source,
    )
    .await
    .unwrap_err();
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        response,
        json!({"error":"media replacement failed","code":"media_replace_failed"})
    );
    let unchanged = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.poster_asset_id, Some(old.id));
    assert!(only_file(root.as_ref(), &old.storage_key).await);
    assert!(
        media_asset::Entity::find_by_id(old.id)
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(media_asset::Entity::find().all(&db).await.unwrap().len(), 1);
    assert_eq!(count_files(root.as_ref()), 1);
}

// Catches a post-commit finish failure losing the durable removal manifest or reporting success.
#[tokio::test]
async fn replacement_finish_failure_preserves_manifest_and_returns_stable_error() {
    let db = database().await;
    let root = TempRoot::new();
    let base_storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &base_storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let movie = draft_movie(&db, Some(old.id)).await;
    let hooks = Arc::new(MakeOperationReadOnlyAfterCommit {
        root: root.as_ref().to_owned(),
        operation: Mutex::new(None),
    });
    let storage = LocalMediaStorage::initialize_with_hooks(root.as_ref(), hooks.clone())
        .await
        .unwrap();

    let (new_source, _) = Chunks::new([jpeg()]);
    let error = replace_attachment(
        &db,
        &storage.clone().into(),
        AttachmentTarget::MoviePoster {
            id: movie.id,
            version: 1,
        },
        "new.jpg",
        "image/jpeg",
        &policy(1024),
        new_source,
    )
    .await
    .unwrap_err();
    let operation = hooks.operation.lock().unwrap().clone().unwrap();
    std::fs::set_permissions(&operation, std::fs::Permissions::from_mode(0o700)).unwrap();
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        response,
        json!({"error":"media replacement finalization failed","code":"media_replace_finalization_failed"})
    );
    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(updated.poster_asset_id, Some(old.id));
    let new = media_asset::Entity::find_by_id(updated.poster_asset_id.unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert!(only_file(root.as_ref(), &new.storage_key).await);
    assert!(!root.as_ref().join(&old.storage_key).exists());
    assert!(
        media_asset::Entity::find_by_id(old.id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    let operations = std::fs::read_dir(root.as_ref().join(".operations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(operations.len(), 1);
    assert!(operations[0].join("manifest.json").is_file());
    assert!(operations[0].join("00000000.data").is_file());
}

// Catches media routes bypassing the content lifecycle's draft-only editing rule.
#[tokio::test]
async fn published_attachment_cannot_be_replaced_and_leaves_no_new_file() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let (old_source, _) = Chunks::new([PNG]);
    let old = store_new_asset(
        &db,
        &storage.clone().into(),
        MediaKind::Poster,
        "old.png",
        "image/png",
        &policy(1024),
        old_source,
    )
    .await
    .unwrap();
    let mut published = draft_movie(&db, Some(old.id)).await.into_active_model();
    published.status = Set("published".into());
    let published = published.update(&db).await.unwrap();

    let (new_source, _) = Chunks::new([jpeg()]);
    assert!(
        replace_attachment(
            &db,
            &storage.clone().into(),
            AttachmentTarget::MoviePoster {
                id: published.id,
                version: 1,
            },
            "new.jpg",
            "image/jpeg",
            &policy(1024),
            new_source,
        )
        .await
        .is_err()
    );
    let unchanged = movie::Entity::find_by_id(published.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.poster_asset_id, Some(old.id));
    assert_eq!(count_files(root.as_ref()), 1);
}

// Catches any slot retaining the old asset/file or falling back to asynchronous cleanup.
#[tokio::test]
async fn replacement_synchronously_removes_old_assets_for_every_attachment_slot() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let mut old_assets = Vec::new();
    for (kind, name, mime, bytes) in [
        (
            MediaKind::Poster,
            "movie-poster.png",
            "image/png",
            PNG.to_vec(),
        ),
        (
            MediaKind::Video,
            "movie-video.mp4",
            "video/mp4",
            valid_mp4(),
        ),
        (
            MediaKind::Poster,
            "series-poster.png",
            "image/png",
            PNG.to_vec(),
        ),
        (
            MediaKind::Video,
            "episode-video.mp4",
            "video/mp4",
            valid_mp4(),
        ),
    ] {
        let (source, _) = Chunks::bytes(bytes);
        old_assets.push(
            store_new_asset(
                &db,
                &storage.clone().into(),
                kind,
                name,
                mime,
                &policy(4096),
                source,
            )
            .await
            .unwrap(),
        );
    }
    let movie = movie::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Movie slots".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(Some(old_assets[0].id)),
        video_asset_id: Set(Some(old_assets[1].id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let series = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Series slots".into()),
        synopsis: Set(String::new()),
        poster_asset_id: Set(Some(old_assets[2].id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let season = season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series.id),
        number: Set(1),
    }
    .insert(&db)
    .await
    .unwrap();
    let episode = episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season.id),
        number: Set(1),
        name: Set("Episode slot".into()),
        video_asset_id: Set(Some(old_assets[3].id)),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let replacements = [
        (
            AttachmentTarget::MoviePoster {
                id: movie.id,
                version: 1,
            },
            "new-movie-poster.jpg",
            "image/jpeg",
            jpeg().to_vec(),
        ),
        (
            AttachmentTarget::MovieVideo {
                id: movie.id,
                version: 2,
            },
            "new-movie-video.mp4",
            "video/mp4",
            valid_mp4(),
        ),
        (
            AttachmentTarget::SeriesPoster {
                id: series.id,
                version: 1,
            },
            "new-series-poster.jpg",
            "image/jpeg",
            jpeg().to_vec(),
        ),
        (
            AttachmentTarget::EpisodeVideo {
                id: episode.id,
                version: 1,
            },
            "new-episode-video.mp4",
            "video/mp4",
            valid_mp4(),
        ),
    ];
    for ((target, name, mime, bytes), old) in replacements.into_iter().zip(&old_assets) {
        let (source, _) = Chunks::bytes(bytes);
        let new = replace_attachment(
            &db,
            &storage.clone().into(),
            target,
            name,
            mime,
            &policy(4096),
            source,
        )
        .await
        .unwrap();
        assert!(only_file(root.as_ref(), &new.storage_key).await);
        assert!(!root.as_ref().join(&old.storage_key).exists());
        assert!(
            media_asset::Entity::find_by_id(old.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
    }
}

async fn run_recovery_during_uncommitted_replacement() {
    let db = database().await;
    let root = TempRoot::new();
    let storage = LocalMediaStorage::initialize(root.as_ref()).await.unwrap();
    let movie = draft_movie(&db, None).await;

    let lock_key = i64::from_be_bytes(
        Uuid::new_v4().as_bytes()[..8]
            .try_into()
            .expect("UUID prefix is eight bytes"),
    );
    db.execute_unprepared(&format!(
        "CREATE FUNCTION pause_replacement_update() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN PERFORM pg_advisory_xact_lock({lock_key}); RETURN NEW; END $$; \
         CREATE TRIGGER pause_replacement_update BEFORE UPDATE ON movie \
         FOR EACH ROW EXECUTE FUNCTION pause_replacement_update()"
    ))
    .await
    .unwrap();
    let mut blocker_options = ConnectOptions::new(
        std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required"),
    );
    blocker_options.max_connections(1).min_connections(1);
    let blocker = Database::connect(blocker_options).await.unwrap();
    blocker
        .execute_unprepared(&format!("SELECT pg_advisory_lock({lock_key})"))
        .await
        .unwrap();

    let upload_db = db.clone();
    let upload_storage = storage.clone();
    let movie_id = movie.id;
    let (source, _) = Chunks::new([jpeg()]);
    let mut upload = tokio::spawn(async move {
        replace_attachment(
            &upload_db,
            &upload_storage.clone().into(),
            AttachmentTarget::MoviePoster {
                id: movie_id,
                version: 1,
            },
            "new.jpg",
            "image/jpeg",
            &policy(1024),
            source,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting = blocker
                .query_one(Statement::from_string(
                    DatabaseBackend::Postgres,
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                     WHERE wait_event_type='Lock' AND wait_event='advisory' \
                     AND query ILIKE '%UPDATE%movie%') AS waiting",
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<bool>("", "waiting")
                .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replacement did not pause after inspecting the old slot");

    let recovery_db = db.clone();
    let recovery_storage = storage.clone();
    let mut recovery = tokio::spawn(async move {
        movie_harbor_api::media::upload::recover_stale_uploads(
            &recovery_db,
            &recovery_storage.clone().into(),
            Duration::ZERO,
        )
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut recovery)
            .await
            .is_err(),
        "recovery crossed the replacement's storage critical section before registration"
    );
    blocker
        .execute_unprepared(&format!("SELECT pg_advisory_unlock({lock_key})"))
        .await
        .unwrap();
    let new = tokio::time::timeout(Duration::from_secs(5), &mut upload)
        .await
        .expect("replacement remained blocked")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut recovery)
        .await
        .expect("recovery remained blocked")
        .unwrap()
        .unwrap();

    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.poster_asset_id, Some(new.id));
    assert!(root.as_ref().join(&new.storage_key).is_file());
    assert!(
        std::fs::read_dir(root.as_ref().join(".incoming"))
            .unwrap()
            .next()
            .is_none()
    );
}

// Catches an empty old slot dropping the transferred mutation guard before commit/registration.
#[tokio::test]
async fn empty_slot_replacement_keeps_recovery_out_until_the_new_file_is_registered() {
    run_recovery_during_uncommitted_replacement().await;
}

// Catches omitting the route or bypassing the shared administrator middleware.
#[tokio::test]
async fn media_upload_routes_are_registered_and_require_authentication() {
    let db = database().await;
    let root = TempRoot::new();
    let movie = draft_movie(&db, None).await;
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let path = format!("/api/admin/media/movies/{}/video?version=1", movie.id);
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                None,
                None,
                "https://harbor.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = credentials(&app).await;
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                Some(&cookie),
                None,
                "https://harbor.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(multipart_request(
                path.clone(),
                Some(&cookie),
                Some(&csrf),
                "https://evil.test"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = app
        .clone()
        .oneshot(multipart_request(
            path.clone(),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.version, 2);
    let video = media_asset::Entity::find_by_id(updated.video_asset_id.unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(video.mime_type, "video/mp4");
    assert!(only_file(root.as_ref(), &video.storage_key).await);

    let stale = app
        .clone()
        .oneshot(multipart_request(
            path,
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        movie::Entity::find_by_id(movie.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );

    let missing_version = app
        .oneshot(multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(missing_version.status(), StatusCode::BAD_REQUEST);
}

// Catches dropping or renaming the stable client-facing code for declared/actual content mismatches.
#[tokio::test]
async fn content_mismatch_response_has_stable_code() {
    let db = database().await;
    let root = TempRoot::new();
    let movie = draft_movie(&db, None).await;
    let app = app::build(db, &config(root.as_ref())).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;

    let response = app
        .oneshot(multipart_file_request(
            format!("/api/admin/media/movies/{}/video?version=1", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
            "invalid.mp4",
            "video/mp4",
            b"not an mp4".to_vec(),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        json!({
            "error": "media content does not match its declared type",
            "code": "media_content_mismatch"
        })
    );
}

// Characterizes every registered attachment target before their handlers share one upload path.
#[tokio::test]
async fn movie_series_and_episode_routes_share_the_attachment_contract() {
    let db = database().await;
    let root = TempRoot::new();
    let movie = draft_movie(&db, None).await;
    let series = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Series".into()),
        synopsis: Set(String::new()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let season = season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series.id),
        number: Set(1),
    }
    .insert(&db)
    .await
    .unwrap();
    let episode = episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season.id),
        number: Set(1),
        name: Set("Pilot".into()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;

    let missing_movie_version = app
        .clone()
        .oneshot(multipart_file_request(
            format!("/api/admin/media/movies/{}/poster", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(missing_movie_version.status(), StatusCode::BAD_REQUEST);

    let movie_poster = app
        .clone()
        .oneshot(multipart_file_request(
            format!("/api/admin/media/movies/{}/poster?version=1", movie.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(movie_poster.status(), StatusCode::OK);
    let movie = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert!(movie.poster_asset_id.is_some());
    assert_eq!(movie.version, 2);

    let series_poster = app
        .clone()
        .oneshot(multipart_file_request(
            format!("/api/admin/media/series/{}/poster?version=1", series.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(series_poster.status(), StatusCode::OK);
    let series_poster_body: Value = serde_json::from_slice(
        &series_poster
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(series_poster_body["version"], 2);
    assert!(
        series::Entity::find_by_id(series.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .poster_asset_id
            .is_some()
    );
    assert_eq!(
        series::Entity::find_by_id(series.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );

    let episode_video = app
        .oneshot(multipart_request(
            format!("/api/admin/media/episodes/{}/video?version=1", episode.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(episode_video.status(), StatusCode::OK);
    let episode_video_body: Value = serde_json::from_slice(
        &episode_video
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(episode_video_body["version"], 2);
    assert_eq!(episode_video_body["series_version"], 3);
    assert!(
        episode::Entity::find_by_id(episode.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .video_asset_id
            .is_some()
    );
    assert_eq!(
        episode::Entity::find_by_id(episode.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );
    assert_eq!(
        series::Entity::find_by_id(series.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .version,
        3
    );
}

// Catches treating an archived series as a blanket media freeze instead of applying the owning
// series/episode entity's own editability rule.
#[tokio::test]
async fn archived_series_poster_stays_read_only_while_draft_episode_video_is_editable() {
    let db = database().await;
    let root = TempRoot::new();
    let series = series::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set("Archived series".into()),
        synopsis: Set(String::new()),
        status: Set("archived".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let season = season::ActiveModel {
        id: Set(Uuid::new_v4()),
        series_id: Set(series.id),
        number: Set(1),
    }
    .insert(&db)
    .await
    .unwrap();
    let episode = episode::ActiveModel {
        id: Set(Uuid::new_v4()),
        season_id: Set(season.id),
        number: Set(1),
        name: Set("Draft episode".into()),
        status: Set("draft".into()),
        version: Set(1),
        ..Default::default()
    }
    .insert(&db)
    .await
    .unwrap();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;

    let poster = app
        .clone()
        .oneshot(multipart_file_request(
            format!("/api/admin/media/series/{}/poster?version=1", series.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
            "poster.png",
            "image/png",
            PNG.to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(poster.status(), StatusCode::CONFLICT);

    let video = app
        .oneshot(multipart_request(
            format!("/api/admin/media/episodes/{}/video?version=1", episode.id),
            Some(&cookie),
            Some(&csrf),
            "https://harbor.test",
        ))
        .await
        .unwrap();
    assert_eq!(video.status(), StatusCode::OK);
    let video: Value =
        serde_json::from_slice(&video.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(video["version"], 2);
    assert_eq!(video["series_version"], 2);
    assert_eq!(
        series::Entity::find_by_id(series.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .status,
        "archived"
    );
}

// Catches disabling Axum's body limit and accepting unbounded multipart metadata/extra fields.
#[tokio::test]
async fn multipart_request_bounds_metadata_and_requires_exactly_one_file_field() {
    let db = database().await;
    let root = TempRoot::new();
    let app = app::build(db.clone(), &config(root.as_ref()))
        .await
        .unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let boundary = "bounded-boundary";

    let movie = draft_movie(&db, None).await;
    let mut oversized_preamble = vec![b'x'; 70 * 1024];
    oversized_preamble.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"movie.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").as_bytes(),
    );
    oversized_preamble.extend_from_slice(&valid_mp4());
    oversized_preamble.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            oversized_preamble,
        ))
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE
    ));

    let movie = draft_movie(&db, None).await;
    let long_name = format!("{}.mp4", "a".repeat(300));
    let mut oversized_filename = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{long_name}\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).into_bytes();
    oversized_filename.extend_from_slice(&valid_mp4());
    oversized_filename.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            oversized_filename,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let movie = draft_movie(&db, None).await;
    let mut multiple = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"movie.mp4\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).into_bytes();
    multiple.extend_from_slice(&valid_mp4());
    multiple.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\nignored\r\n--{boundary}--\r\n").as_bytes(),
    );
    let response = app
        .clone()
        .oneshot(raw_multipart_request(
            format!("/api/admin/media/movies/{}/video", movie.id),
            &cookie,
            &csrf,
            boundary,
            multiple,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let movie = movie::Entity::find_by_id(movie.id)
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(movie.video_asset_id, None);
}
