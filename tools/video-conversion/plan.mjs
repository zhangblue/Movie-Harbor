export const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub",
]);

// 将轨道标志转换为 FFmpeg 参数，供保留输出轨道的默认等属性。
function dispositionValue(track) {
  const flags = Object.entries(track.disposition ?? {})
    .filter(([name, value]) => value === 1 && name !== "attached_pic")
    .map(([name]) => name);
  return flags.join("+") || "0";
}

// 根据轨道编码选择复制或转码，并在执行前拒绝不支持的图像字幕。
export function buildConversionPlan(media) {
  for (const subtitle of media.subtitles) {
    if (IMAGE_SUBTITLE_CODECS.has(subtitle.codec)) {
      throw new Error(`不支持图像字幕：轨道 ${subtitle.index}（${subtitle.codec}），请先处理字幕后重试`);
    }
  }

  const videoCopy = media.video.codec === "h264" && media.video.pixelFormat === "yuv420p";
  const video = { ...media.video, mode: videoCopy ? "copy" : "transcode", encoder: videoCopy ? "copy" : "libx264" };
  const audio = media.audio.map((track) => ({
    ...track,
    mode: track.codec === "aac" ? "copy" : "transcode",
    encoder: track.codec === "aac" ? "copy" : "aac",
  }));
  const subtitles = media.subtitles.map((track) => ({ ...track, mode: "transcode", encoder: "mov_text" }));
  const maps = [video, ...audio, ...subtitles].map((track) => `0:${track.index}`);
  const requiredEncoders = [...new Set([video, ...audio, ...subtitles]
    .filter((track) => track.mode === "transcode").map((track) => track.encoder))];

  return {
    maps, video, audio, subtitles, requiredEncoders,
    // 按转换计划生成 FFmpeg 参数，保留轨道、元数据和章节并写入临时文件。
    buildArguments({ inputPath, temporaryPath, progressTarget = "pipe:1" }) {
      const args = [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats",
        "-progress", progressTarget, "-n", "-i", inputPath,
      ];
      for (const map of maps) args.push("-map", map);
      args.push("-c:v:0", video.encoder);
      if (!videoCopy) {
        args.push("-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
      }
      args.push("-tag:v:0", "avc1", "-disposition:v:0", dispositionValue(video));
      // 逐条添加音轨编码和标志，保证多音轨各自使用计划结果。
      audio.forEach((track, index) => {
        args.push(`-c:a:${index}`, track.encoder);
        if (track.mode === "transcode") args.push(`-b:a:${index}`, "192k");
        args.push(`-disposition:a:${index}`, dispositionValue(track));
      });
      // 逐条添加字幕编码和标志，避免遗漏多字幕轨。
      subtitles.forEach((track, index) => {
        args.push(`-c:s:${index}`, track.encoder, `-disposition:s:${index}`, dispositionValue(track));
      });
      args.push("-map_metadata", "0", "-map_chapters", "0", "-movflags", "+faststart+use_metadata_tags", temporaryPath);
      return args;
    },
  };
}
