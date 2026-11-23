//! 视频正文的原始字节进度与元数据限制。
use super::MediaError;
use axum::{
    body::{Body, BodyDataStream, Bytes},
    extract::{FromRequest, Multipart, Request},
    http::{HeaderValue, header::CONTENT_TYPE},
};
use futures_util::{StreamExt, stream};
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

/// 视频上传只对等待下一个非空正文块计时，磁盘写入及服务端校验不计入空闲。
const IDLE: Duration = Duration::from_secs(60);

// 原始流与 multipart 提取器只共享这四种阶段值。
const READING_HEADERS: u8 = 0;
const READING_FILE: u8 = 1;
const OVER_BUDGET: u8 = 2;
const IDLE_EXPIRED: u8 = 3;

/// 首字段提取和错误映射共用的阶段记录，正文流只在真实错误时修改为终态。
#[derive(Clone, Default)]
pub(super) struct Progress(Arc<AtomicU8>);

impl Progress {
    /// 解析器产出首字段后释放前缀检查，下游继续使用同一份文件字段。
    pub(super) fn field_ready(&self) {
        self.0.store(READING_FILE, Ordering::Relaxed);
    }

    /// 将原始正文读取时发生的超限或空闲转为路由可识别的状态。
    pub(super) fn classify(&self, original: MediaError) -> MediaError {
        match self.0.load(Ordering::Relaxed) {
            OVER_BUDGET => MediaError::TooLarge,
            IDLE_EXPIRED => MediaError::UploadIdle,
            _ => original,
        }
    }
}

/// 单个视频请求的原始流、未交付的当前帧与剩余字节额度。
struct Reader {
    source: BodyDataStream,
    pending: Bytes,
    header_left: u64,
    prefix: Vec<u8>,
    content_type: Option<HeaderValue>,
    total_left: u64,
    progress: Progress,
}

/// 在解析 multipart 前包装原始正文；构造时不读取任何 HTTP 帧。
pub(super) fn guard(request: Request, declared: u64, metadata_limit: u64) -> (Request, Progress) {
    let progress = Progress::default();
    let content_type = request.headers().get(CONTENT_TYPE).cloned();
    let request = request.map(|body| {
        let reader = Reader {
            source: body.into_data_stream(),
            pending: Bytes::new(),
            header_left: metadata_limit,
            prefix: Vec::new(),
            content_type,
            total_left: declared.saturating_add(metadata_limit),
            progress: progress.clone(),
        };
        Body::from_stream(stream::try_unfold(reader, Reader::read))
    });
    (request, progress)
}

impl Reader {
    /// 限量向解析器交付当前帧，使它在继续预取前有机会产出字段或文件数据。
    async fn read(mut self) -> io::Result<Option<(Bytes, Self)>> {
        if self.header_left == 0 && self.progress.0.load(Ordering::Relaxed) == READING_HEADERS {
            // 主解析器可能在解释头部前继续预取。用相同解析器和明确 EOF 检查有限前缀：
            // 能取得首字段等价于完整的前导、边界和字段头均在额度内，后面的字节属于文件。
            let mut probe = Request::new(Body::from(std::mem::take(&mut self.prefix)));
            if let Some(content_type) = self.content_type.take() {
                probe.headers_mut().insert(CONTENT_TYPE, content_type);
            }
            let mut parser = Multipart::from_request(probe, &())
                .await
                .map_err(io::Error::other)?;
            if !matches!(parser.next_field().await, Ok(Some(_))) {
                self.progress.0.store(OVER_BUDGET, Ordering::Relaxed);
                return Err(io::Error::other("video multipart header limit exceeded"));
            }
            self.progress.field_ready();
        }
        tokio::task::yield_now().await;
        if self.pending.is_empty() {
            let next = tokio::time::timeout(IDLE, async {
                loop {
                    match self.source.next().await {
                        Some(Ok(bytes)) if bytes.is_empty() => tokio::task::yield_now().await,
                        other => break other,
                    }
                }
            })
            .await
            .map_err(|_| {
                self.progress.0.store(IDLE_EXPIRED, Ordering::Relaxed);
                io::Error::new(io::ErrorKind::TimedOut, "video upload idle")
            })?;
            let Some(bytes) = next else {
                return Ok(None);
            };
            self.pending = bytes.map_err(io::Error::other)?;
        }
        // 只有长度完全匹配的首字段才会进入下一字段提取。总额度减去已核对文件长度，
        // 即首尾所有元数据共用的额度，额外字段头也不能消耗声明的视频字节数。
        let header = self.progress.0.load(Ordering::Relaxed) == READING_HEADERS;
        let budget = if header {
            self.header_left.min(self.total_left)
        } else {
            self.total_left
        };
        let count = (self.pending.len() as u64).min(budget).min(64 * 1024);
        if count == 0 {
            self.progress.0.store(OVER_BUDGET, Ordering::Relaxed);
            return Err(io::Error::other("video multipart metadata limit exceeded"));
        }
        if header {
            self.prefix
                .extend_from_slice(&self.pending[..count as usize]);
            self.header_left -= count;
        }
        self.total_left -= count;
        let chunk = self.pending.split_to(count as usize);
        Ok(Some((chunk, self)))
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, Bytes},
        extract::{FromRequest, Multipart, Request},
    };
    use futures_util::{StreamExt, stream};
    use std::{io, time::Duration};

    /// 在独立的内存 HTTP 请求中检查媒体解析结果，使用小额度验证边界。
    async fn parse(
        frames: Vec<(u64, Bytes)>,
        declared: u64,
        metadata_limit: u64,
    ) -> Result<Vec<u8>, super::MediaError> {
        let body = Body::from_stream(stream::iter(frames).then(|(seconds, bytes)| async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            Ok::<_, io::Error>(bytes)
        }));
        let req = Request::builder()
            .header("content-type", "multipart/form-data; boundary=X")
            .body(body)
            .unwrap();
        let (req, progress) = super::guard(req, declared, metadata_limit);
        let mut multipart = Multipart::from_request(req, &())
            .await
            .map_err(|_| progress.classify(super::MediaError::InvalidFileName))?;
        let field = multipart
            .next_field()
            .await
            .map_err(|_| progress.classify(super::MediaError::InvalidFileName))?
            .ok_or(super::MediaError::InvalidFileName)?;
        progress.field_ready();
        let data = field
            .bytes()
            .await
            .map_err(|_| progress.classify(super::MediaError::InvalidFileName))?;
        if multipart
            .next_field()
            .await
            .map_err(|_| progress.classify(super::MediaError::InvalidFileName))?
            .is_some()
        {
            return Err(super::MediaError::InvalidFileName);
        }
        Ok(data.to_vec())
    }

    /// 使用合法的一字节文件比较原始帧间隔，持续进展的总时长可以超过一分钟。
    #[tokio::test(start_paused = true)]
    async fn video_stream_idle_deadline_tracks_nonempty_frames() {
        let head =
            Bytes::from_static(b"--X\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n");
        let tail = Bytes::from_static(b"\r\n--X--\r\n");
        assert!(
            parse(
                vec![
                    (1, head.clone()),
                    (40, Bytes::new()),
                    (30, Bytes::from_static(b"a")),
                    (0, tail.clone())
                ],
                1,
                128
            )
            .await
            .is_err()
        );
        assert_eq!(
            parse(
                vec![(40, head), (40, Bytes::from_static(b"a")), (40, tail)],
                1,
                128
            )
            .await
            .unwrap(),
            b"a"
        );
    }

    /// 文件内容和头在同一个小帧中也按解析阶段分别计费，限制独立于声明大小。
    #[tokio::test]
    async fn video_metadata_budget_is_independent_of_file_size() {
        let frame = Bytes::from_static(
            b"--X\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n1234567890\r\n--X--\r\n",
        );
        assert!(parse(vec![(0, frame.clone())], 2048, 16).await.is_err());
        assert_eq!(
            parse(vec![(0, frame)], 10, 64).await.unwrap(),
            b"1234567890"
        );
    }
    /// 短正文前的前导或字段元数据超过独立额度时，返回大小错误。
    #[tokio::test]
    async fn oversized_preamble_and_field_headers_exhaust_only_metadata_budget() {
        let head = "--X\r\nContent-Disposition: form-data; name=\"file\"\r\n";
        let padding = "a".repeat(192);
        for frame in [
            format!("{padding}\r\n{head}\r\nx\r\n--X--\r\n"),
            format!("{head}X-Label: {padding}\r\n\r\nx\r\n--X--\r\n"),
        ] {
            assert!(matches!(
                parse(vec![(0, Bytes::from(frame))], 4096, 128).await,
                Err(super::MediaError::TooLarge)
            ));
        }
    }

    /// 文件后合法的第二个字段也受元数据预算约束，超出时给出大小错误。
    #[tokio::test]
    async fn video_trailing_metadata_uses_only_remaining_allowance() {
        let first = Bytes::from_static(
            b"--X\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nx\r\n",
        );
        let second = Bytes::from_static(
            b"--X\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\ny\r\n--X--\r\n",
        );
        assert!(matches!(
            parse(vec![(0, first), (0, second)], 1, 64).await,
            Err(super::MediaError::TooLarge)
        ));
    }
    /// 一次立即交付大帧时，短字段头只占少数字节，其余视频内容不消耗头部额度。
    #[tokio::test]
    async fn video_large_ready_first_frame_with_short_headers_is_accepted() {
        let payload = vec![b'x'; 192 * 1024];
        let mut body = b"--X\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n".to_vec();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\r\n--X--\r\n");
        let req = Request::builder()
            .header("content-type", "multipart/form-data; boundary=X")
            .body(Body::from(body))
            .unwrap();
        let (req, progress) = super::guard(req, payload.len() as u64, 64 * 1024);
        let mut multipart = Multipart::from_request(req, &()).await.unwrap();
        let field = multipart.next_field().await.unwrap().unwrap();
        progress.field_ready();
        assert_eq!(field.bytes().await.unwrap(), payload);
    }
}
