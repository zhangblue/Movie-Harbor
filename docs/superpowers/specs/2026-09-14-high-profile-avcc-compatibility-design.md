# High Profile MP4 avcC 兼容性修复设计

日期：2026-09-14

## 1. 背景

Movie Harbor 当前会解析 MP4 视频轨道中的 AVCDecoderConfigurationRecord（`avcC`），并验证 H.264 的 SPS、PPS、NAL 长度和采样数据。对于 High Profile 及相关档次，校验器在读完 SPS 和 PPS 后无条件要求存在 chroma format、bit depth 和 SPS extension count 四个扩展字节。

部分合法、可由浏览器直接播放的 H.264/AAC MP4 不携带这段可选扩展信息。此类文件的 `avcC` 会在最后一个 PPS 后恰好结束。当前代码因此把合法文件误判为“media content does not match its declared type”。

## 2. 目标

- 接受 `avcC` 在最后一个 PPS 后合法结束的 High Profile H.264 MP4。
- 保持已有的 MP4 容器、品牌、视频编码、参数集、采样表、NAL 和资源边界校验。
- 对确实携带 High Profile 扩展字段的文件继续执行完整、严格的扩展校验。
- 为已确认的真实文件结构建立小型、可重复的自动化回归测试。

## 3. 非目标

- 不增加 HEVC、AV1 或其他视频编码支持。
- 不调用外部 `ffprobe`、FFmpeg 或浏览器进程进行上传校验。
- 不执行自动转封装、转码或修复上传文件。
- 不改变上传接口、前端行为、部署镜像或 MIME 白名单。
- 不降低损坏参数集、非法 NAL、异常尺寸、越界偏移和解析资源消耗的拒绝标准。

## 4. 校验规则

校验器继续按顺序读取并验证 `avcC` 的固定头、全部 SPS 和全部 PPS。

对于 High Profile 及当前代码识别的相关档次：

1. 如果游标在最后一个 PPS 后恰好到达 `avcC` 末尾，则扩展区视为未提供，继续进行 SPS/PPS 语义解析和采样数据校验。
2. 如果 PPS 后仍有任何字节，则必须存在完整的四字节扩展头，并满足保留位、chroma format 和 bit depth 规则。
3. 扩展头声明的每个 SPS extension 必须完整存在、长度有效且 NAL 类型为 13。
4. 扩展解析结束后仍要求游标恰好到达 `avcC` 末尾；截断或多余尾部数据继续拒绝。

Baseline、Main 等非 High Profile 的现有规则不变，PPS 后出现额外数据仍被拒绝。

## 5. 实现范围

- `backend/src/media/validation.rs`：仅在 High Profile 分支中把扩展区改为“无剩余字节时可省略；存在剩余字节时完整校验”。
- `backend/tests/media_upload_test.rs`：从现有可播放 High Profile MP4 fixture 派生一个移除可选扩展区的 MP4，同时正确调整包含它的 box 长度；通过真实上传存储入口验证接受结果。
- `backend/src/media/validation.rs` 的单元测试：直接覆盖无扩展区可接受，以及非空但截断的扩展区仍被拒绝。

不修改公共 API 或数据库，因此无需迁移和前端变更。

## 6. 测试策略

遵循 TDD：

1. 先增加无扩展区 High Profile MP4 的上传回归测试并运行，确认当前实现返回内容不匹配。
2. 增加解析器级测试，覆盖合法省略与残缺扩展区。
3. 实现最小条件分支，使合法 fixture 通过。
4. 运行媒体上传测试、后端工作区测试、格式检查和 Clippy，确认既有伪造文件与资源边界测试仍然通过。

## 7. 验收标准

- 与问题文件相同 `avcC` 布局的 H.264 High Profile/AAC MP4 上传成功。
- 已携带合法扩展区的 High Profile fixture 继续上传成功。
- 只有一部分扩展字节、扩展 NAL 非法或存在多余尾部数据的 MP4 继续被拒绝。
- 现有媒体上传安全回归测试全部通过。
