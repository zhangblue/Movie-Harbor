function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseProbeOutput(text) {
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    throw new Error("FFprobe 输出不是有效的 JSON");
  }
  if (!isRecord(output)) throw new Error("FFprobe 输出结构无效");
  if (output.format !== undefined && !isRecord(output.format)) {
    throw new Error("FFprobe format 结构无效");
  }
  if (!Array.isArray(output.streams)) throw new Error("FFprobe 缺少有效的 streams 列表");

  const indices = new Set();
  const streams = output.streams.map((stream) => {
    if (!isRecord(stream) || !Number.isInteger(stream.index) || stream.index < 0) {
      throw new Error("FFprobe 轨道索引必须是非负整数");
    }
    if (indices.has(stream.index)) throw new Error(`FFprobe 轨道索引 ${stream.index} 重复`);
    indices.add(stream.index);
    const disposition = isRecord(stream.disposition) ? { ...stream.disposition } : {};
    return {
      index: stream.index,
      type: optionalString(stream.codec_type),
      codec: optionalString(stream.codec_name),
      pixelFormat: optionalString(stream.pix_fmt),
      attachedPic: disposition.attached_pic === 1,
      tags: isRecord(stream.tags) ? { ...stream.tags } : {},
      disposition,
    };
  });
  const video = streams.find((stream) => stream.type === "video" && !stream.attachedPic);
  if (!video) throw new Error("没有可用的视频轨");
  const rawDuration = output.format?.duration;
  const duration = typeof rawDuration === "string" || typeof rawDuration === "number"
    ? Number(rawDuration) : NaN;
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    video,
    audio: streams.filter((stream) => stream.type === "audio"),
    subtitles: streams.filter((stream) => stream.type === "subtitle"),
  };
}
