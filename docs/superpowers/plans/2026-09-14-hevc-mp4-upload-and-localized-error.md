# HEVC MP4 上传与中文错误提示实现计划

> **执行说明：** 使用 `superpowers-zh:subagent-driven-development` 或 `superpowers-zh:executing-plans` 按任务逐项实施；每项都遵循测试驱动开发，先观察预期失败，再写最少实现并验证。

**目标：** 在保留现有媒体内容校验的前提下，允许上传采用 HEVC 编码且样本项为 `hvc1` 或 `hev1` 的 MP4，并将媒体内容与声明类型不匹配的管理端提示改为清晰中文。

**架构：** 扩展后端现有 MP4 box、sample table 与媒体样本校验器，使其根据样本项分派 H.264 或 HEVC 配置和 NAL 单元校验；上传接口继续返回 HTTP 415，但为内容不匹配错误补充稳定错误码。管理端电影和剧集编辑器只根据错误码显示中文，不依赖英文文本匹配。

**技术栈：** Rust、Axum、Tokio、React、TypeScript、Vitest、Testing Library。

---

## 任务 1：为 MP4 校验器增加严格 HEVC 支持

**文件：**

- 新增：`backend/tests/fixtures/hevc-hvc1.mp4`
- 修改：`backend/src/media/validation.rs`
- 修改：`backend/tests/media_upload_test.rs`

### 第 1 步：生成并固定一个最小 HEVC 测试夹具

使用本机 FFmpeg 生成一段极小的 `hvc1`、HEVC Main、YUV 4:2:0 MP4，仅作为测试输入，不引入运行时 FFmpeg 依赖：

```bash
ffmpeg -f lavfi -i color=c=black:s=16x16:d=0.12 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -an -movflags +faststart backend/tests/fixtures/hevc-hvc1.mp4
```

确认夹具体积足够小，并通过 `ffprobe` 验证 `codec_name=hevc`、`codec_tag_string=hvc1`。该文件进入版本控制；不得复制或提交用户的实际视频。

### 第 2 步：先写 HEVC 接受测试并确认失败

在 `backend/tests/media_upload_test.rs` 中通过 `include_bytes!("fixtures/hevc-hvc1.mp4")` 读取夹具，新增测试覆盖：

- `hvc1` HEVC MP4 可通过 `LocalMediaStorage::store`。
- 将夹具样本项 fourcc 从 `hvc1` 定点替换为 `hev1` 后也可通过。

运行：

```bash
cargo test -p movie-harbor-api --test media_upload_test mp4_validation_accepts_hvc1_and_hev1_hevc -- --nocapture
```

预期：测试失败，错误为 `MediaError::ContentMismatch`，证明现有实现确实拒绝 HEVC。

### 第 3 步：写 HEVC 配置与样本拒绝测试

在 `backend/src/media/validation.rs` 的单元测试中为 `hvcC` 添加最小合法配置测试，并覆盖：

- `lengthSizeMinusOne` 对应 1、2、4 字节 NAL 长度前缀时通过。
- 保留值 3 字节长度前缀被拒绝。
- 配置缺少 VPS、SPS 或 PPS 时被拒绝。
- 配置数组或 NAL 长度越过 payload 边界时被拒绝。
- 配置数组声明的 NAL 类型与实际 NAL 头不一致时被拒绝。
- NAL 的 `forbidden_zero_bit` 非零或 `nuh_temporal_id_plus1` 为零时被拒绝。

在集成测试中增加变异夹具，覆盖：

- 截断 `hvcC` 被拒绝。
- 删除 VPS、SPS 或 PPS 数组被拒绝。
- HEVC 样本内 NAL 长度越界或 NAL 头非法被拒绝。
- 未支持的 `av01` 样本项仍被拒绝。

运行相关测试，确认它们在实现前失败：

```bash
cargo test -p movie-harbor-api media::validation -- --nocapture
cargo test -p movie-harbor-api --test media_upload_test hevc -- --nocapture
```

### 第 4 步：实现 `hvcC` 与 HEVC NAL 校验

在 `backend/src/media/validation.rs` 中将单一 H.264 配置扩展为编解码器枚举：

```rust
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
```

调整 MP4 track 解析和配置校验：

- `avc1`、`avc3` 继续要求并解析 `avcC`。
- `hvc1`、`hev1` 要求并解析 `hvcC`。
- 其他视频样本项继续返回内容不匹配。

实现 `validate_hvcc(payload: &[u8]) -> Option<usize>`，至少验证：

- `configurationVersion == 1` 且固定头长度不少于 23 字节。
- 保留位和字段取值合法。
- NAL 长度前缀仅允许 1、2、4 字节。
- 数组数、数组元素数和每个 NAL 长度均受 payload 边界约束。
- 每个数组的类型与其中 NAL 头类型一致。
- VPS、SPS、PPS 三类参数集均至少出现一次。
- payload 被完整消费，并为数组和 NAL 数量设置合理上限。

保留现有 sample table 和 `mdat` 范围校验，根据配置枚举分派样本验证。新增 HEVC 样本验证器，逐个样本检查：

- NAL 长度前缀完整且不会越过样本边界。
- 每个 NAL 至少包含 2 字节 HEVC 头。
- `forbidden_zero_bit == 0`。
- `nuh_temporal_id_plus1 != 0`。
- 每个非空样本至少包含一个 VCL NAL（类型 0–31）。
- 单个样本最多处理 10,000 个 NAL，并且最终恰好消费完整样本。

### 第 5 步：运行后端聚焦验证

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p movie-harbor-api media::validation -- --nocapture
cargo test -p movie-harbor-api --test media_upload_test -- --nocapture
```

全部通过后提交：

```bash
git add backend/src/media/validation.rs backend/tests/media_upload_test.rs backend/tests/fixtures/hevc-hvc1.mp4
git commit -m "feat: 支持 HEVC MP4 上传校验"
```

---

## 任务 2：增加稳定错误码并显示中文提示

**文件：**

- 修改：`backend/src/media/mod.rs`
- 修改：`backend/tests/media_upload_test.rs`
- 修改：`frontend/admin-web/src/movies/MovieEditor.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`README.md`

### 第 1 步：先写后端错误响应测试

在认证上传路由测试中上传声明为 MP4、内容却无效的文件，断言返回 HTTP 415，响应体同时包含：

```json
{
  "error": "media content does not match its declared type",
  "code": "media_content_mismatch"
}
```

运行并确认新增的 `code` 断言失败：

```bash
cargo test -p movie-harbor-api --test media_upload_test content_mismatch_response_has_stable_code -- --nocapture
```

### 第 2 步：实现后端稳定错误码

在 `MediaError::into_response` 中为 `MediaError::ContentMismatch` 增加专门响应分支，返回现有英文 `error` 和稳定 `code`。不要通过匹配错误字符串判断错误类型；其他错误响应行为保持不变。

重新运行上一步测试，确认通过。

### 第 3 步：先写电影与剧集编辑器中文提示测试

分别在 `MovieEditor.test.tsx` 和 `SeriesEditor.test.tsx` 中，让上传 API 抛出带 `media_content_mismatch` 错误码的 `ApiError`，断言界面显示精确文案：

```text
上传失败：文件内容与声明的类型不匹配，请确认文件格式正确且未损坏。
```

运行并确认两个测试在实现前失败：

```bash
npm test --workspace @movie-harbor/admin-web -- MovieEditor.test.tsx SeriesEditor.test.tsx
```

### 第 4 步：实现前端错误码映射

在两个编辑器的失败处理逻辑中，在通用错误分支之前加入：

```ts
if (cause instanceof ApiError && apiErrorCode(cause) === "media_content_mismatch") {
  setError("上传失败：文件内容与声明的类型不匹配，请确认文件格式正确且未损坏。");
}
```

如两个文件已有其他错误码分支，则保持原有优先级和文案，仅加入本错误码映射。确保从共享 API client 导入并使用 `apiErrorCode`。

### 第 5 步：更新用户文档

将 `README.md` 的视频格式说明更新为：

- 支持 WebM。
- 支持 H.264 MP4。
- 支持 HEVC MP4 的 `hvc1`、`hev1` 样本项。
- 实际播放能力仍取决于访问者浏览器和操作系统对 HEVC 的支持；服务不会自动转码。

### 第 6 步：运行聚焦验证并提交

```bash
cargo test -p movie-harbor-api --test media_upload_test content_mismatch_response_has_stable_code -- --nocapture
npm test --workspace @movie-harbor/admin-web -- MovieEditor.test.tsx SeriesEditor.test.tsx
npm run build --workspace @movie-harbor/admin-web
git diff --check
```

全部通过后提交：

```bash
git add backend/src/media/mod.rs backend/tests/media_upload_test.rs frontend/admin-web/src/movies/MovieEditor.tsx frontend/admin-web/src/movies/MovieEditor.test.tsx frontend/admin-web/src/series/SeriesEditor.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx README.md
git commit -m "fix: 本地化媒体内容错误提示"
```

---

## 任务 3：用实际视频验证并完成全量检查

**文件：**

- 临时修改后还原：`backend/src/media/validation.rs`

### 第 1 步：用忽略测试验证用户实际文件

在 `backend/src/media/validation.rs` 的测试模块临时加入一个 `#[ignore]` 测试，从 `MOVIE_HARBOR_REAL_MP4` 环境变量读取路径，并调用私有 `validate_content` 走与上传一致的完整 MP4 校验。测试不得读取完整视频到内存，只打开文件并使用现有流式校验入口。

运行：

```bash
MOVIE_HARBOR_REAL_MP4='/Users/zhangdi/Downloads/已加速- L餐馆 (2026).TC1080P.mp4' cargo test -p movie-harbor-api validates_external_hevc_mp4 -- --ignored --nocapture
```

预期：测试通过。随后使用 `apply_patch` 删除这个临时测试，并重新运行 `cargo fmt --all -- --check`。不得复制、修改或提交用户视频。

### 第 2 步：运行项目级验证

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
git diff --check
```

如果 E2E 因目标机环境或浏览器依赖不可用而失败，记录准确命令、错误和已通过的其余验证，不得将环境失败描述为代码通过。

### 第 3 步：检查交付边界

```bash
git status --short
git log --oneline -3
```

确认：

- 提交中没有用户媒体、真实 `.env`、数据库或 `data/` 内容。
- 没有引入运行时 FFmpeg 或自动转码。
- H.264 和 WebM 原有校验仍通过。
- 实际 HEVC 文件通过上传入口所用的同一校验逻辑。
- 后端返回稳定错误码，电影和剧集管理页面均显示中文提示。

