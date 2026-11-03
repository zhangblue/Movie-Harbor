import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveMediaReference } from "./media-path.mjs";

// 读取导出结构时要求对象值，并用字段上下文报告错误。
function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

// 读取必需自有字段，避免原型属性被当成导出数据。
function field(source, name, context) {
  if (!Object.hasOwn(source, name)) throw new Error(`${context}.${name} is required`);
  return source[name];
}

// 读取并校验字符串字段，必要时拒绝空白值。
function string(source, name, context, nonblank = false) {
  const value = field(source, name, context);
  if (typeof value !== "string" || (nonblank && value.trim() === "")) {
    throw new Error(`${context}.${name} must be ${nonblank ? "a nonblank" : "a"} string`);
  }
  return value;
}

// 读取可选布尔字段，兼容未包含该字段的旧导出。
function optionalBoolean(source, name, context, fallback = false) {
  if (!Object.hasOwn(source, name)) return fallback;
  if (typeof source[name] !== "boolean") throw new Error(`${context}.${name} must be a boolean`);
  return source[name];
}

// 校验可空整数及范围，供年份和时长等字段解析使用。
function nullableInteger(source, name, context, minimum = -2147483648) {
  const value = field(source, name, context);
  if (value !== null && (!Number.isInteger(value) || value < minimum || value > 2147483647)) {
    throw new Error(`${context}.${name} must be an i32${minimum === 0 ? " nonnegative" : ""} integer or null`);
  }
  return value;
}

// 校验非空字符串数组，供题材列表解析使用。
function stringArray(source, name, context) {
  const value = field(source, name, context);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${context}.${name} must be an array of nonblank strings`);
  }
  return value;
}

// 读取必需数组字段，供内容和层级解析使用。
function array(source, name, context) {
  const value = field(source, name, context);
  if (!Array.isArray(value)) throw new Error(`${context}.${name} must be an array`);
  return value;
}

// 校验导出时间及日历日期，供来源身份和续传使用。
function timestamp(source) {
  const value = string(source, "exported_at", "export");
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || Number.isNaN(Date.parse(value)) || month < 1 || month > 12
      || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error("export.exported_at must be an RFC 3339 timestamp");
  }
  return value;
}

// 解析媒体字段并验证本地引用，供电影、剧集和单集预检使用。
async function media(source, name, kind, mediaRoot, context) {
  const path = field(source, name, context);
  if (path !== null && typeof path !== "string") {
    throw new Error(`${context}.${name} must be a string or null`);
  }
  return resolveMediaReference(mediaRoot, path, kind);
}

// 验证电影导出字段和媒体，导入前形成规范化数据。
async function parseMovies(source, mediaRoot) {
  const names = new Set();
  const result = [];
  for (const [index, raw] of array(source, "movies", "export").entries()) {
    const context = `movies[${index}]`;
    const item = object(raw, context);
    const name = string(item, "name", context, true);
    if (names.has(name)) throw new Error(`duplicate movie name: ${name}`);
    names.add(name);
    result.push({
      name,
      isPrivate: optionalBoolean(item, "is_private", context),
      synopsis: string(item, "synopsis", context),
      year: nullableInteger(item, "year", context),
      genres: stringArray(item, "genres", context),
      poster: await media(item, "poster_path", "poster", mediaRoot, context),
      video: await media(item, "video_path", "video", mediaRoot, context),
      durationSeconds: nullableInteger(item, "duration_seconds", context, 0),
    });
  }
  return result;
}

// 验证剧集、季和单集层级及媒体，导入前形成规范化数据。
async function parseSeries(source, mediaRoot) {
  const names = new Set();
  const result = [];
  for (const [index, raw] of array(source, "series", "export").entries()) {
    const context = `series[${index}]`;
    const item = object(raw, context);
    const name = string(item, "name", context, true);
    if (names.has(name)) throw new Error(`duplicate series name: ${name}`);
    names.add(name);
    const episodes = [];
    const coordinates = new Set();
    for (const [episodeIndex, rawEpisode] of array(item, "episodes", context).entries()) {
      const episodeContext = `${context}.episodes[${episodeIndex}]`;
      const entry = object(rawEpisode, episodeContext);
      const seasonNumber = nullableInteger(entry, "season_number", episodeContext);
      const episodeNumber = nullableInteger(entry, "episode_number", episodeContext);
      if (seasonNumber === null || seasonNumber <= 0) throw new Error(`${episodeContext}.season_number must be positive`);
      if (episodeNumber === null || episodeNumber <= 0) throw new Error(`${episodeContext}.episode_number must be positive`);
      const coordinate = `${seasonNumber}:${episodeNumber}`;
      if (coordinates.has(coordinate)) throw new Error(`duplicate episode ${seasonNumber}:${episodeNumber} in series: ${name}`);
      coordinates.add(coordinate);
      episodes.push({
        seasonNumber,
        episodeNumber,
        name: string(entry, "name", episodeContext, true),
        video: await media(entry, "video_path", "video", mediaRoot, episodeContext),
        durationSeconds: nullableInteger(entry, "duration_seconds", episodeContext, 0),
      });
    }
    result.push({
      name,
      isPrivate: optionalBoolean(item, "is_private", context),
      synopsis: string(item, "synopsis", context),
      year: nullableInteger(item, "year", context),
      genres: stringArray(item, "genres", context),
      poster: await media(item, "poster_path", "poster", mediaRoot, context),
      episodes,
    });
  }
  return result;
}

// 读取并完整预检导出文件与媒体，计算来源身份后才允许导入。
export async function loadAndValidateExport(jsonPath, mediaRoot) {
  const bytes = await readFile(jsonPath);
  const parsed = object(JSON.parse(bytes), "export");
  const identity = {
    exportedAt: timestamp(parsed),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    identity,
    movies: await parseMovies(parsed, mediaRoot),
    series: await parseSeries(parsed, mediaRoot),
  };
}
