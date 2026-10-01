# 网站兼容 MP4 转换 CLI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 提供一个只处理单个本机 MKV 或 MP4 的 Node.js CLI，按需调用 FFprobe 与 FFmpeg，安全生成固定命名的网站兼容 MP4，并保留全部音轨和文本字幕。

**架构：** 入口层只负责参数、路径与消息；探测层把 FFprobe JSON 归一化为内部媒体描述；纯规划器决定显式轨道映射和逐轨编码参数；执行层管理子进程、进度、临时文件、信号和最终原子发布。FFmpeg/FFprobe 是用户安装的外部程序，不进入网站运行时或发布镜像。

**技术栈：** Node.js 24 ESM、Node 内置测试框架、FFmpeg/FFprobe CLI。

---

## 文件结构

- 创建 `tools/convert-video.mjs`：CLI 入口、参数和路径校验、中文输出、退出码。
- 创建 `tools/video-conversion/probe.mjs`：FFprobe 进程调用与 JSON 归一化。
- 创建 `tools/video-conversion/plan.mjs`：纯转换规划、图像字幕拒绝、FFmpeg 参数构造。
- 创建 `tools/video-conversion/execute.mjs`：外部依赖预检、进度解析、FFmpeg 生命周期、临时文件和原子发布。
- 创建 `tests/video-conversion-plan.test.mjs`：媒体描述与 FFmpeg 参数的纯行为测试。
- 创建 `tests/video-conversion-cli.test.mjs`：以真实子进程替身验证 CLI、文件和信号边界。
- 修改 `package.json`：增加转换入口与聚焦测试脚本。
- 创建 `docs/guides/video-conversion.md`：安装、使用、编码规则、字幕限制与空间说明。
- 修改 `README.md`：增加转换工具状态和指南入口，保持服务端不自动转码的说明。
- 修改 `tests/documentation.test.mjs`：把新指南纳入可导航文档集合。

## 任务 1：实现媒体描述与纯转换规划

**文件：**

- 创建：`tools/video-conversion/probe.mjs`
- 创建：`tools/video-conversion/plan.mjs`
- 创建：`tests/video-conversion-plan.test.mjs`

- [ ] **步骤 1：编写 FFprobe 归一化失败测试**

先点名要抓住的破坏：如果解析器接受异常 JSON、选择封面视频、漏掉后续音轨/字幕，或丢失轨道索引与元数据，测试必须失败。

在 `tests/video-conversion-plan.test.mjs` 构造字面量 FFprobe JSON，调用尚不存在的 `parseProbeOutput`：

```js
const media = parseProbeOutput(JSON.stringify({
  format: { duration: "120.5", tags: { title: "示例" } },
  streams: [
    { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
    { index: 1, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le", disposition: { attached_pic: 0 } },
    { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "zho" } },
    { index: 3, codec_type: "audio", codec_name: "dts", tags: { language: "eng" } },
    { index: 4, codec_type: "subtitle", codec_name: "subrip", tags: { title: "简体中文" } },
  ],
}));

assert.equal(media.durationSeconds, 120.5);
assert.equal(media.video.index, 1);
assert.deepEqual(media.audio.map(({ index, codec }) => [index, codec]), [[2, "aac"], [3, "dts"]]);
assert.deepEqual(media.subtitles.map(({ index, codec }) => [index, codec]), [[4, "subrip"]]);
```

另加测试，确认空输入、非 JSON、没有 `streams`、重复/非整数轨道索引、没有非封面视频时抛出明确错误。

- [ ] **步骤 2：运行测试并确认正确失败**

运行：

```bash
node --test tests/video-conversion-plan.test.mjs
```

预期：FAIL，错误指出 `tools/video-conversion/probe.mjs` 或 `parseProbeOutput` 尚不存在，而不是测试语法错误。

- [ ] **步骤 3：实现最小媒体描述解析**

在 `probe.mjs` 导出：

```js
export function parseProbeOutput(text) {
  // JSON.parse 后验证 format/streams；保留 index、codec、pixelFormat、
  // attachedPic、tags、disposition；选择第一条非 attached_pic 视频。
  return { durationSeconds, video, audio, subtitles };
}
```

要求：

- 时长只有在有限且大于零时才返回数字，否则为 `null`。
- 轨道索引必须是非负整数且全局不重复。
- `codec_type`、`codec_name`、`pix_fmt` 缺失时使用可诊断的空值，不伪造兼容编码。
- 没有主视频时抛出“没有可用的视频轨”。
- 不在这里判断转码策略或启动进程。

- [ ] **步骤 4：编写转换计划失败测试**

先点名要抓住的破坏：如果规划器让 FFmpeg 自动选轨、遗漏任一音轨/文本字幕、全局覆盖逐轨音频策略、误复制非兼容视频，或接受图像字幕，测试必须失败。

增加表格测试并手工断言完整参数片段：

```js
const plan = buildConversionPlan({
  durationSeconds: 120.5,
  video: { index: 1, codec: "hevc", pixelFormat: "yuv420p10le" },
  audio: [
    { index: 2, codec: "aac", tags: { language: "zho" }, disposition: {} },
    { index: 3, codec: "dts", tags: { language: "eng" }, disposition: {} },
  ],
  subtitles: [
    { index: 4, codec: "subrip", tags: { title: "简体中文" }, disposition: {} },
    { index: 5, codec: "ass", tags: { title: "English" }, disposition: {} },
  ],
});

assert.deepEqual(plan.maps, ["0:1", "0:2", "0:3", "0:4", "0:5"]);
assert.equal(plan.video.mode, "transcode");
assert.deepEqual(plan.audio.map(({ mode }) => mode), ["copy", "transcode"]);
assert.deepEqual(plan.subtitles.map(({ encoder }) => encoder), ["mov_text", "mov_text"]);
```

覆盖：

- H.264 + `yuv420p` 视频为 `copy`；H.264 其他像素格式仍转码。
- 转码视频包含 `libx264`、CRF 20、`medium`、`yuv420p` 和偶数尺寸表达式。
- 每条 AAC 使用 `-c:a:N copy`，每条非 AAC 使用 `-c:a:N aac -b:a:N 192k`。
- 每条字幕使用 `-c:s:N mov_text`。
- 参数包含 `-map_metadata 0`、`-map_chapters 0`、`-movflags +faststart`，不含附件或自动映射。
- `hdmv_pgs_subtitle`、`dvd_subtitle`、`dvb_subtitle`、`xsub` 分别在规划阶段抛错，并包含轨道索引和编码名称。
- 零音轨或零字幕仍能产生有效计划。

- [ ] **步骤 5：运行规划测试并确认失败原因**

运行：

```bash
node --test tests/video-conversion-plan.test.mjs
```

预期：解析测试已通过；规划测试 FAIL，因为 `buildConversionPlan` 尚不存在或尚未产生显式逐轨参数。

- [ ] **步骤 6：实现最小纯规划器**

在 `plan.mjs` 导出：

```js
export const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub",
]);

export function buildConversionPlan(media) {
  // 返回 maps、video、audio、subtitles、requiredEncoders，
  // 并提供 buildArguments({ inputPath, temporaryPath, progressTarget })。
}
```

`buildArguments` 必须使用绝对输入轨道索引映射，输出轨道编码选项按输出类型序号编号；视频转码滤镜固定为：

```text
scale=trunc(iw/2)*2:trunc(ih/2)*2
```

参数同时包含 `-nostdin`、`-hide_banner`、`-loglevel error`、`-nostats`、`-progress pipe:1` 和 `-n`。输入、临时输出均作为独立数组元素，不包含 shell 引号。

- [ ] **步骤 7：运行任务 1 测试并提交**

运行：

```bash
node --test tests/video-conversion-plan.test.mjs
git diff --check
```

预期：全部通过。

提交：

```bash
git add tools/video-conversion/probe.mjs tools/video-conversion/plan.mjs tests/video-conversion-plan.test.mjs
git commit -m "feat: 规划网站兼容视频转换"
```

## 任务 2：实现安全的 CLI 与转码生命周期

**文件：**

- 创建：`tools/video-conversion/execute.mjs`
- 创建：`tools/convert-video.mjs`
- 创建：`tests/video-conversion-cli.test.mjs`

- [ ] **步骤 1：创建真实外部程序测试替身并编写失败测试**

先点名要抓住的破坏：如果 CLI 通过 shell 传参、在预检失败后仍启动 FFmpeg、直接写最终文件、失败后残留临时文件或覆盖目标，测试必须失败。

在 `tests/video-conversion-cli.test.mjs` 中为每个测试创建独立临时目录，并写入可执行的 `ffprobe`、`ffmpeg` Node 脚本：

- FFprobe 从环境变量读取 fixture JSON并输出到 stdout。
- FFmpeg 把 `process.argv.slice(2)` 逐项 JSON 编码写到日志文件，向 stdout 写 `out_time_ms=...\nprogress=continue\n`，再按测试环境变量决定创建输出、成功、失败或等待信号。
- 测试通过修改子进程 `PATH` 使用替身，不修改全局环境，不调用真实 FFmpeg。

实际启动 `node tools/convert-video.mjs <input>`，覆盖：

- `--help` 返回 `0` 且不启动任何外部程序。
- 缺少参数、额外参数和不支持扩展名返回 `2`。
- 输入不存在、目录输入、目标已存在返回 `1`，且 FFprobe/FFmpeg 日志不存在。
- 包含中文、空格、单引号、分号和 `$()` 的路径在 FFmpeg 参数日志中仍是单个原值。
- PGS fixture 只启动 FFprobe，不启动 FFmpeg，错误包含轨道索引与编码名。
- 成功时 FFmpeg 接收临时 `.mp4` 路径，最终只有固定命名输出，临时文件消失。
- FFmpeg 非零退出时最终输出不存在，临时文件被清理，stderr 只显示诊断尾部。

- [ ] **步骤 2：运行 CLI 测试并确认正确失败**

运行：

```bash
node --test tests/video-conversion-cli.test.mjs
```

预期：FAIL，入口或执行模块尚不存在；测试替身自身可正常启动。

- [ ] **步骤 3：实现外部进程与媒体探测**

在 `execute.mjs` 实现并导出：

```js
export async function probeMedia(inputPath, options = {}) {}
export async function verifyRequiredEncoders(requiredEncoders, options = {}) {}
export async function executeConversion({ inputPath, outputPath, media, plan }, options = {}) {}
```

实现要求：

- 使用 `spawn(executable, args, { shell: false, stdio: [...] })`。
- FFprobe 参数显式包含 JSON 输出、格式时长和所需流字段；stdout 与 stderr 都设置大小上限，超限时终止子进程并报错。
- 区分 `ENOENT` 与外部程序非零退出，分别给出“未安装/不可执行”和诊断错误。
- `verifyRequiredEncoders` 只检查计划需要的 `libx264`、`aac`、`mov_text`，复制模式不要求对应编码器。
- 诊断环形缓冲只保留最后 16 KiB，错误消息不得包含伪造的 shell 命令。

- [ ] **步骤 4：实现临时文件、进度与原子发布**

`executeConversion` 使用输出目录中的唯一临时名，例如：

```js
const temporaryPath = join(
  dirname(outputPath),
  `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp.mp4`,
);
```

实现要求：

- FFmpeg 成功且临时文件是普通文件后，使用 `link(temporaryPath, outputPath)` 把完整 inode 原子发布到最终路径，再 `unlink(temporaryPath)` 删除临时名字。
- `link` 遇到 `EEXIST` 时报告目标已存在；不能退回会覆盖目标的 `rename`。发布成功后即使删除临时名字失败，最终文件仍然完整，错误需明确指出可安全手动删除哪个临时名字。
- 所有失败路径在 `finally` 中删除本次临时文件；`ENOENT` 可忽略，其他清理错误合并进主错误。
- 解析 `out_time_ms`/`out_time_us` 与 `progress`；已知时长时报告截断到 `0..100` 的整数百分比，未知时长报告已处理时长。
- 输出进度更新不写入 FFmpeg stdin，`-nostdin` 保持启用。

- [ ] **步骤 5：实现 CLI 入口与中文错误**

在 `tools/convert-video.mjs` 导出可测试的：

```js
export async function run(argv, dependencies = {}) {
  // 返回 0、1 或 2；直接执行时赋给 process.exitCode。
}
```

入口规则：

- `--help` 是唯一选项；帮助或恰好一个位置参数之外的形式返回 `2`。
- 使用 `resolve` 规范化输入，以 `stat` 验证普通文件，以不区分大小写方式验证 `.mkv`/`.mp4`。
- 通过 `parse`/`format` 生成 `<name>.movie-harbor.mp4`，不能用字符串替换扩展名。
- 在任何外部程序调用前以 `lstat`/`access` 检查最终路径不存在。
- 顺序固定为：路径预检 → FFprobe → 纯规划 → 所需编码器检查 → FFmpeg → 成功摘要。
- 错误分类为参数错误 `2` 与运行错误 `1`；消息使用 `ERROR ...`，成功使用 `完成：<路径>`。

- [ ] **步骤 6：增加中断与依赖错误失败测试**

扩展 CLI 集成测试：

- PATH 中没有 FFprobe 时返回 `1` 并提示安装 FFmpeg。
- 计划需要 `libx264`，但编码器替身未列出时，不启动转码。
- 子 FFmpeg 等待时向 CLI 发送 `SIGINT`，断言信号被转发、进程退出、临时文件删除、最终文件不存在。
- 无可靠 duration 时输出已处理时间而不包含百分号。
- 超长 stderr 只保留尾部标记，不回显开头标记。

运行并确认新增测试先因缺少信号转发、编码器预检或有界缓冲而失败。

- [ ] **步骤 7：实现信号与剩余错误路径**

执行器为当前 FFmpeg 子进程临时注册 `SIGINT`/`SIGTERM` 监听器：收到信号后只转发给该子进程；子进程结束后移除监听器。在 CLI 直接执行路径中，根据中断设置非零退出状态；测试调用 `run` 时不得强制结束测试进程。

补齐 encoder 列表解析、未知字幕转码失败诊断、无时长进度、输出竞争和清理错误组合。不要给生产模块添加只供测试使用的销毁函数。

- [ ] **步骤 8：运行任务 2 测试并提交**

运行：

```bash
node --test tests/video-conversion-plan.test.mjs tests/video-conversion-cli.test.mjs
git diff --check
```

预期：全部通过，测试结束后无残留子进程或临时文件。

提交：

```bash
git add tools/video-conversion/execute.mjs tools/convert-video.mjs tests/video-conversion-cli.test.mjs
git commit -m "feat: 添加安全视频转换命令行工具"
```

## 任务 3：接入项目脚本并交付使用文档

**文件：**

- 修改：`package.json`
- 创建：`docs/guides/video-conversion.md`
- 修改：`README.md`
- 修改：`tests/documentation.test.mjs`

- [ ] **步骤 1：先扩展文档导航测试并确认失败**

先点名要抓住的破坏：如果 README 未暴露新指南、指南没有返回 README 的入口或链接目标不存在，导航测试必须失败。

把 `video-conversion.md` 加入 `tests/documentation.test.mjs` 的 `guides` 字面量列表：

```js
const guides = [
  "deployment.md",
  "offline-package.md",
  "content-transfer.md",
  "video-conversion.md",
  "media-and-backup.md",
  "development.md",
  "database-schema.md",
];
```

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：FAIL，指出新指南尚未从 README 导航。

- [ ] **步骤 2：增加 npm 入口并验证真实帮助行为**

在根 `package.json` 增加：

```json
{
  "scripts": {
    "convert:video": "node tools/convert-video.mjs",
    "test:video-conversion": "node --test tests/video-conversion-*.test.mjs"
  }
}
```

运行：

```bash
npm run convert:video -- --help
npm run test:video-conversion
```

预期：帮助命令退出 `0` 并显示单文件用法；聚焦测试全部通过。

- [ ] **步骤 3：编写视频转换指南**

创建 `docs/guides/video-conversion.md`，完整写明：

- 这是上传前的本机独立工具，网站服务仍不自动转码。
- FFmpeg/FFprobe 必须同时可从 PATH 执行，并给出 `ffmpeg -version`、`ffprobe -version` 自检命令。
- 精确调用示例和固定输出命名示例。
- H.264/`yuv420p`、CRF 20、`medium`、AAC 192 kbps、`mov_text` 和 faststart 规则。
- 已兼容轨道会复制；复制仍会重新封装成新 MP4。
- 所有音轨与文本字幕保留；图像字幕的常见名称以及“检测即停止”行为。
- 临时文件、输出不覆盖、失败清理、原片不修改和至少预留一个完整输出文件空间的建议。
- 成功后先本地抽查播放，再上传；网站上传校验仍是最终判断。
- 顶部提供 `[返回项目 README](../../README.md)`。

- [ ] **步骤 4：更新 README 并验证导航**

在“当前状态”增加“本地转换工具”，说明单文件 MKV/MP4 可在上传前转成网站兼容 MP4；在“使用与运维文档”增加指南链接。保留“视频不自动转码”并明确它指服务端行为，避免与 CLI 描述冲突。

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：PASS，新指南和所有既有指南链接均可解析。

- [ ] **步骤 5：运行项目相关回归**

运行：

```bash
npm run test:video-conversion
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm test --workspaces
npm run build --workspaces
git diff --check
```

预期：全部命令退出码为 `0`，没有残留转换临时文件。此工具不涉及后端、数据库、Compose 或跨服务流程，因此不要求为本任务额外运行 PostgreSQL、Rust 或 Playwright E2E；若实现期间意外修改这些领域，必须改为执行 AGENTS.md 对应的完整验证子集。

- [ ] **步骤 6：提交文档与入口**

```bash
git add package.json README.md docs/guides/video-conversion.md tests/documentation.test.mjs
git commit -m "docs: 补充视频转换工具指南"
```

## 计划自检映射

- 规格的命令行、固定命名与退出码：任务 2、任务 3。
- FFprobe 归一化、第一条非封面视频、全部音轨与字幕：任务 1。
- H.264/`yuv420p` 复制、按需转码、CRF 20、AAC 192 kbps、`mov_text`、faststart：任务 1。
- 图像字幕预检拒绝：任务 1、任务 2。
- 无 shell 参数、安全文件名、有界诊断：任务 2。
- 临时文件、原子发布、不覆盖、中断清理：任务 2。
- 依赖检查、中文错误与进度：任务 2。
- npm 入口、README 和独立指南：任务 3。
