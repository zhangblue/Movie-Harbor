import assert from "node:assert/strict";
import test from "node:test";
import { parseProbeOutput } from "../tools/video-conversion/probe.mjs";

// Catch cover selection, lost later tracks, and discarded track metadata.
test("probe preserves every audio/subtitle track and selects the first real video", () => {
  const media = parseProbeOutput(JSON.stringify({
    format: { duration: "120.5", tags: { title: "示例" } },
    streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
      { index: 1, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le", tags: { title: "主视频" }, disposition: { attached_pic: 0, default: 1 } },
      { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "zho" }, disposition: { default: 1 } },
      { index: 3, codec_type: "audio", codec_name: "dts", tags: { language: "eng", title: "English" }, disposition: { forced: 0 } },
      { index: 4, codec_type: "subtitle", codec_name: "subrip", tags: { title: "简体中文" }, disposition: { forced: 1 } },
      { index: 5, codec_type: "attachment", codec_name: "ttf" },
      { index: 6, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
    ],
  }));
  assert.equal(media.durationSeconds, 120.5);
  assert.deepEqual(media.video, { index: 1, type: "video", codec: "hevc", pixelFormat: "yuv420p10le", attachedPic: false, tags: { title: "主视频" }, disposition: { attached_pic: 0, default: 1 } });
  assert.deepEqual(media.audio.map(({ index, codec }) => [index, codec]), [[2, "aac"], [3, "dts"]]);
  assert.deepEqual(media.audio[1].tags, { language: "eng", title: "English" });
  assert.deepEqual(media.audio[0].disposition, { default: 1 });
  assert.deepEqual(media.subtitles.map(({ index, codec }) => [index, codec]), [[4, "subrip"]]);
  assert.deepEqual(media.subtitles[0].tags, { title: "简体中文" });
  assert.deepEqual(media.subtitles[0].disposition, { forced: 1 });
});

// Catch accepting malformed probe output or ambiguous/invalid absolute stream indices.
for (const [name, input, message] of [
  ["empty", "", /FFprobe.*JSON/],
  ["non JSON", "bad", /FFprobe.*JSON/],
  ["null", "null", /FFprobe.*结构/],
  ["missing streams", JSON.stringify({ format: {} }), /streams/],
  ["invalid format", JSON.stringify({ format: [], streams: [] }), /format/],
  ["duplicate index", JSON.stringify({ streams: [{ index: 0 }, { index: 0 }] }), /轨道索引.*重复/],
  ["fraction index", JSON.stringify({ streams: [{ index: 0.5 }] }), /轨道索引/],
  ["negative index", JSON.stringify({ streams: [{ index: -1 }] }), /轨道索引/],
  ["string index", JSON.stringify({ streams: [{ index: "0" }] }), /轨道索引/],
  ["missing index", JSON.stringify({ streams: [{}] }), /轨道索引/],
  ["cover only", JSON.stringify({ streams: [{ index: 0, codec_type: "video", disposition: { attached_pic: 1 } }] }), /没有可用的视频轨/],
]) test(`probe rejects ${name}`, () => assert.throws(() => parseProbeOutput(input), message));

// Catch fabricating a reliable duration or compatible codec when fields are absent.
for (const duration of [undefined, "N/A", "Infinity", "0", "-1", ""]) {
  test(`probe reports unknown duration for ${duration}`, () => {
    const media = parseProbeOutput(JSON.stringify({ format: { duration }, streams: [{ index: 8, codec_type: "video" }, { index: 9 }] }));
    assert.equal(media.durationSeconds, null);
    assert.equal(media.video.codec, null);
    assert.equal(media.video.pixelFormat, null);
    assert.deepEqual(media.video.tags, {});
    assert.deepEqual(media.video.disposition, {});
  });
}

// Catch automatic stream selection, omitted tracks, and a global audio codec override.
test("plan emits complete explicit maps and independent audio/subtitle encoders", async () => {
  const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
  const plan = buildConversionPlan({
    durationSeconds: 120.5,
    video: { index: 1, codec: "hevc", pixelFormat: "yuv420p10le" },
    audio: [{ index: 2, codec: "aac" }, { index: 3, codec: "dts" }],
    subtitles: [{ index: 4, codec: "subrip" }, { index: 5, codec: "ass" }],
  });
  assert.deepEqual(plan.maps, ["0:1", "0:2", "0:3", "0:4", "0:5"]);
  assert.equal(plan.video.mode, "transcode");
  assert.deepEqual(plan.audio.map(({ mode }) => mode), ["copy", "transcode"]);
  assert.deepEqual(plan.subtitles.map(({ encoder }) => encoder), ["mov_text", "mov_text"]);
  assert.deepEqual(plan.requiredEncoders, ["libx264", "aac", "mov_text"]);
  assert.deepEqual(plan.buildArguments({ inputPath: "/中文/a ' ; $(test).mkv", temporaryPath: "/中文/a.tmp.mp4" }), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-n",
    "-i", "/中文/a ' ; $(test).mkv",
    "-map", "0:1", "-map", "0:2", "-map", "0:3", "-map", "0:4", "-map", "0:5",
    "-c:v:0", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-tag:v:0", "avc1",
    "-c:a:0", "copy", "-c:a:1", "aac", "-b:a:1", "192k",
    "-c:s:0", "mov_text", "-c:s:1", "mov_text",
    "-map_metadata", "0", "-map_chapters", "0", "-movflags", "+faststart", "/中文/a.tmp.mp4",
  ]);
});

// Catch copying HEVC, high bit-depth H.264, or unknown codecs as compatible video.
for (const [codec, pixelFormat, mode, encoders] of [
  ["h264", "yuv420p", "copy", []],
  ["h264", "yuv420p10le", "transcode", ["libx264"]],
  ["h264", "yuv444p", "transcode", ["libx264"]],
  ["hevc", "yuv420p", "transcode", ["libx264"]],
  [null, null, "transcode", ["libx264"]],
]) test(`plan ${mode} for ${codec}/${pixelFormat} with no audio or subtitle`, async () => {
  const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
  const plan = buildConversionPlan({ video: { index: 7, codec, pixelFormat }, audio: [], subtitles: [] });
  assert.equal(plan.video.mode, mode);
  assert.deepEqual(plan.maps, ["0:7"]);
  assert.deepEqual(plan.requiredEncoders, encoders);
  const args = plan.buildArguments({ inputPath: "/in.mp4", temporaryPath: "/out.mp4", progressTarget: "pipe:3" });
  assert.deepEqual(args.slice(0, 14), ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:3", "-n", "-i", "/in.mp4", "-map", "0:7", "-c:v:0", mode === "copy" ? "copy" : "libx264"]);
  assert.equal(args.includes("-vf"), mode === "transcode");
  assert.equal(args.some((arg) => /^-c:[as]/.test(arg)), false);
});

// Catch rejecting unknown text codecs or requesting encoders for copied AAC.
test("plan keeps unknown subtitles and copies all AAC tracks", async () => {
  const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
  const plan = buildConversionPlan({ video: { index: 0, codec: "h264", pixelFormat: "yuv420p" }, audio: [{ index: 5, codec: "aac" }, { index: 9, codec: "aac" }], subtitles: [{ index: 20, codec: null }] });
  assert.deepEqual(plan.maps, ["0:0", "0:5", "0:9", "0:20"]);
  assert.deepEqual(plan.requiredEncoders, ["mov_text"]);
  assert.deepEqual(plan.audio.map(({ mode }) => mode), ["copy", "copy"]);
  assert.equal(plan.subtitles[0].encoder, "mov_text");
});

// Catch silently dropping or trying to mux any known bitmap subtitle.
for (const codec of ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]) {
  test(`plan rejects image subtitle ${codec} before conversion`, async () => {
    const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
    assert.throws(() => buildConversionPlan({ video: { index: 0, codec: "h264", pixelFormat: "yuv420p" }, audio: [], subtitles: [{ index: 42, codec }] }), (error) => /图像字幕/.test(error.message) && error.message.includes("42") && error.message.includes(codec));
  });
}
