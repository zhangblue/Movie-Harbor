# High Profile MP4 avcC 兼容性修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 允许上传 `avcC` 在最后一个 PPS 后结束的合法 High Profile H.264 MP4，同时保持其余媒体安全校验不变。

**架构：** 保留现有 MP4 与 H.264 深度校验，只调整 `validate_avcc` 的 High Profile 扩展区边界：无剩余字节时接受省略，存在剩余字节时仍要求完整且严格合法。通过解析器单元测试与真实存储上传入口的 MP4 fixture 双层覆盖回归。

**技术栈：** Rust 2024、Tokio、h264-reader 0.8、现有本地媒体存储测试工具。

---

## 文件结构

- 修改 `backend/src/media/validation.rs`：修正 High Profile `avcC` 可选扩展区的解析条件，并增加解析器级边界测试。
- 修改 `backend/tests/media_upload_test.rs`：派生与问题文件布局一致的无扩展 High Profile MP4 fixture，并通过上传存储入口验证。

### 任务 1：兼容省略 High Profile 扩展区的 MP4

**文件：**
- 修改：`backend/src/media/validation.rs:1054-1079,1225-1267`
- 测试：`backend/tests/media_upload_test.rs:1742-1765,1987-2007`

- [ ] **步骤 1：阅读测试质量约定**

完整阅读 `superpowers-zh:test-driven-development` 技能引用的 `writing-good-tests.md`，确认新增测试验证公开上传行为，且 fixture 构造代码不复制生产解析器实现。

- [ ] **步骤 2：编写真实上传入口的失败回归测试**

在 `backend/tests/media_upload_test.rs` 增加只移除现有 High Profile fixture 最后四个合法扩展字节的辅助函数：

```rust
fn ffmpeg_high_h264_mp4_without_avcc_extensions() -> Vec<u8> {
    let bytes = ffmpeg_high_h264_mp4();
    let avcc = bytes.windows(4).position(|bytes| bytes == b"avcC").unwrap();
    let size = u32::from_be_bytes(bytes[avcc - 4..avcc].try_into().unwrap()) as usize;
    let mut payload = bytes[avcc + 4..avcc - 4 + size].to_vec();
    assert_eq!(&payload[payload.len() - 4..], &[0xfd, 0xf8, 0xf8, 0x00]);
    payload.truncate(payload.len() - 4);
    replace_mp4_avcc(bytes, payload)
}
```

把 fixture 加入现有浏览器可播放 MP4 表格：

```rust
(
    "high-without-extensions.mp4",
    ffmpeg_high_h264_mp4_without_avcc_extensions(),
),
```

- [ ] **步骤 3：运行测试并确认因目标缺陷失败**

运行：

```bash
cargo test -p movie-harbor-api --test media_upload_test mp4_validation_accepts_ffmpeg_baseline_with_aac_and_high_profile -- --nocapture
```

预期：FAIL，`high-without-extensions.mp4` 返回 `media content does not match its declared type`；原 baseline、AAC 和带扩展 High Profile fixture 没有失败。

- [ ] **步骤 4：增加解析器级失败测试**

在 `backend/src/media/validation.rs` 的测试模块复用现有合法 High Profile `avcC` 字节，增加两个断言：移除最后四个扩展字节后应返回 `Some(4)`；只保留一至三个扩展字节时均返回 `None`。

```rust
let core = &avcc[..avcc.len() - 4];
assert_eq!(
    validate_avcc(core).map(|configuration| configuration.nal_length_bytes),
    Some(4),
);
for trailing_length in 1..4 {
    assert!(validate_avcc(&avcc[..core.len() + trailing_length]).is_none());
}
```

再次运行：

```bash
cargo test -p movie-harbor-api media::validation::tests -- --nocapture
```

预期：无扩展断言 FAIL；残缺扩展断言 PASS。

- [ ] **步骤 5：实现最小解析条件**

只在 High Profile 且 PPS 后仍有数据时进入现有扩展解析逻辑：

```rust
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
```

不修改 `cursor != payload.len()`、SPS/PPS 语义解析、采样表或 NAL 校验。

- [ ] **步骤 6：运行专用测试确认通过**

运行：

```bash
cargo test -p movie-harbor-api media::validation::tests -- --nocapture
cargo test -p movie-harbor-api --test media_upload_test -- --nocapture
```

预期：解析器边界测试和全部媒体上传测试通过，包括已有伪造 MP4、非法参数集、极端尺寸与资源消耗保护用例。

- [ ] **步骤 7：运行后端回归与静态检查**

运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
```

预期：全部命令退出码为 0，无格式、Clippy、测试或空白错误。

- [ ] **步骤 8：提交修复**

```bash
git add backend/src/media/validation.rs backend/tests/media_upload_test.rs docs/superpowers/plans/2026-09-14-high-profile-avcc-compatibility.md
git commit -m "fix: 兼容省略 avcC 扩展区的 MP4"
```

预期：提交仅包含解析器、回归测试和本实现计划，不包含部署数据或用户视频。
