import { z } from 'zod';
import { id, nextActions, positiveInt, status, uuidPattern, version } from './common.js';
import { apiEpisodeEnvelope, apiMovie, apiSeries } from './content.js';
import { isLocalMediaPath, validatePosterOutput } from './media.js';

// 严格输入对象拒绝未知键时，固定中文消息避免 SDK 在错误中回显路径或凭据。
const invalidParameters = { error: '参数无效，请按工具声明提供参数。' };

// 限定访问范围、海报和缺视频查询的顶层内容类型。
const topLevelContentType = z.enum(['movie', 'series'], invalidParameters);
// 限定访问范围操作必须显式指定公开或私密。
const visibility = z.enum(['public', 'private'], invalidParameters);
// 统一维护请求和上传资产的 UUID 为小写，便于核对响应归属和新旧资产。
const canonicalId = z.string(invalidParameters).regex(uuidPattern, invalidParameters).toLowerCase();
// 维护输入的正安全整数与所有版本约束一致，字段错误在进入 SDK 前固定为中文。
const inputVersion = z.int(invalidParameters).positive(invalidParameters);
// 单集与顶层内容沿用相同状态集合，输入错误与其他维护参数一致。
const inputStatus = z.enum(status.options, invalidParameters);
// 为已确认的维护操作复用内容标识、乐观版本和独立确认字段。
const maintenanceFields = { content_id: canonicalId, version: inputVersion, confirmed: z.literal(true, invalidParameters) };

// 只接受明确确认、携带版本的电影或整剧访问范围修改。
export const setContentVisibilityInput = z.strictObject({
  ...maintenanceFields,
  content_type: topLevelContentType,
  visibility,
}, invalidParameters);

// 只接受明确确认、携带版本和绝对本地路径的电影或整剧海报写入。
export const setContentPosterInput = z.strictObject({
  ...maintenanceFields,
  content_type: topLevelContentType,
  path: z.string(invalidParameters).refine(isLocalMediaPath, invalidParameters),
}, invalidParameters);

// 两种详情响应共享顶层 ID、版本、状态和可空海报字段，上传前只核对这些数据。
export const apiContentPosterDetail = apiMovie.pick({ id: true, version: true, status: true, poster: true });
// 校验海报上传响应的媒体 ID、MIME、实际字节数和目标内容版本。
export const apiContentPosterUpload = z.object({
  id: canonicalId,
  version,
  mime_type: validatePosterOutput.shape.mime_type,
  byte_size: positiveInt,
});

// 海报结果只返回本次补传或替换的元数据、内容版本和后续操作。
export const setContentPosterOutput = z.strictObject({
  content_type: topLevelContentType,
  content_id: id,
  version,
  media_id: id,
  format: validatePosterOutput.shape.format,
  byte_size: positiveInt,
  action: z.enum(['added', 'replaced']),
  next_actions: nextActions,
});

// 转换生命周期时严格区分顶层内容与携带完整归属的单集。
export const transitionContentLifecycleInput = z.discriminatedUnion('content_type', [
  z.strictObject({ ...maintenanceFields, content_type: z.literal('movie'), target_status: inputStatus }, invalidParameters),
  z.strictObject({ ...maintenanceFields, content_type: z.literal('series'), target_status: inputStatus }, invalidParameters),
  z.strictObject({
    ...maintenanceFields,
    content_type: z.literal('episode'),
    series_id: canonicalId,
    season_id: canonicalId,
    target_status: inputStatus,
  }, invalidParameters),
], invalidParameters);

// 解析访问范围详情和写入响应时只读取本工具使用的字段。
export const apiContentVisibility = z.object({ id, version, is_private: z.boolean() });
// 解析电影或整剧状态响应时保留身份、状态和实际版本。
export const apiContentLifecycle = z.object({ id, version, status });
// 校验单集的父剧标识、版本、状态与剧集层级。
export const apiLifecycleParent = apiSeries.pick({ id: true, version: true, status: true, seasons: true });
// 读取和更新单集时复用既有响应封装，包含所属季和父剧集版本。
export const apiLifecycleEpisode = apiEpisodeEnvelope;

// 访问范围结果提供修改后的范围、实际版本和后续读取入口。
export const setContentVisibilityOutput = z.strictObject({
  content_type: topLevelContentType,
  content_id: id,
  visibility,
  version,
  next_actions: nextActions,
});

// 依次记录已完成的状态转换，幂等成功时路径为空。
const lifecycleResultFields = {
  content_id: id,
  previous_status: status,
  transitioned_through: z.array(status).max(2),
  status,
  version,
  next_actions: nextActions,
};

// 只有单集类型返回转换影响的父剧集版本。
export const transitionContentLifecycleOutput = z.discriminatedUnion('content_type', [
  z.strictObject({ ...lifecycleResultFields, content_type: z.literal('movie') }),
  z.strictObject({ ...lifecycleResultFields, content_type: z.literal('series') }),
  z.strictObject({ ...lifecycleResultFields, content_type: z.literal('episode'), series_version: version }),
]);

// 沿用管理内容 API 页码上限，供缺视频请求和响应校验。
const missingVideoPageNumber = inputVersion.max(1_000_000, invalidParameters);
// 固定页大小与管理内容 API 保持一致，供页大小和条目数量校验。
const missingVideoPageSize = 20;

// 缺视频查询须明确选定电影或剧集，可省略第一页页码。
export const listMissingVideosInput = z.strictObject({
  content_type: topLevelContentType,
  page: missingVideoPageNumber.optional(),
}, invalidParameters);

// 缺视频电影条目提供槽位所属电影的标识、名称、状态、版本和访问范围。
const missingMovieItem = z.strictObject({
  movie_id: id,
  movie_name: z.string().min(1),
  status,
  version,
  is_private: z.boolean(),
});

// 缺视频单集条目提供完整剧季集定位，访问范围沿用整剧。
const missingEpisodeItem = z.strictObject({
  series_id: id,
  series_name: z.string().min(1),
  series_status: status,
  series_version: version,
  season_id: id,
  season_number: positiveInt,
  episode_id: id,
  episode_number: positiveInt,
  episode_name: z.string().min(1),
  episode_status: status,
  episode_version: version,
  is_private: z.boolean(),
});

// 约束两种分页分支共用的页码、固定页大小和无符号总数。
const missingVideoPageFields = {
  page: missingVideoPageNumber,
  size: z.literal(missingVideoPageSize),
  total: z.int().nonnegative(),
};

// 校验后端分页与 MCP 成功结果，确保类型和条目对应且没有额外媒体字段。
export const listMissingVideosOutput = z.discriminatedUnion('content_type', [
  z.strictObject({
    ...missingVideoPageFields,
    content_type: z.literal('movie'),
    items: z.array(missingMovieItem).max(missingVideoPageSize),
  }),
  z.strictObject({
    ...missingVideoPageFields,
    content_type: z.literal('series'),
    items: z.array(missingEpisodeItem).max(missingVideoPageSize),
  }),
]);

// 系统概览查询没有业务参数，使用固定错误避免回显未知字段名。
export const getSystemOverviewInput = z.strictObject({}, { error: '系统概览无需参数' });

// 概览整数保持精确，超出 JavaScript 安全范围时拒绝响应，避免精度损失。
const overviewCount = z.int().nonnegative();

// 校验电影、剧集和单集按生命周期拆分的数据库数量。
const overviewLifecycleCounts = z.strictObject({
  draft: overviewCount,
  published: overviewCount,
  archived: overviewCount,
});

// 校验海报与视频各自的数量和数据库记录字节数。
const overviewAssetCounts = z.strictObject({ count: overviewCount, bytes: overviewCount });

// 卷 0 的数据库统计和保留空间在容量采样失败后仍由后端返回。
const overviewVolumeFields = {
  number: z.literal(0),
  reserve_bytes: overviewCount,
  asset_count: overviewCount,
  recorded_asset_bytes: overviewCount,
};

// 按后端给出的卷状态校验容量字段，保留已知值或显式 null。
const overviewVolume = z.discriminatedUnion('status', [
  z.strictObject({
    ...overviewVolumeFields,
    status: z.enum(['healthy', 'space_low']),
    total_bytes: overviewCount,
    available_bytes: overviewCount,
    writable_bytes: overviewCount,
    accepts_uploads: z.boolean(),
  }),
  z.strictObject({
    ...overviewVolumeFields,
    status: z.literal('unavailable'),
    total_bytes: z.null(),
    available_bytes: z.null(),
    writable_bytes: z.null(),
    accepts_uploads: z.literal(false),
  }),
]);

// 只接收后端稳定的告警码、卷范围和说明，阻止路径或底层错误借告警字段传出。
const overviewWarning = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('storage_space_low'),
    scope: z.literal('volume:0'),
    message: z.literal('媒体卷空间不足'),
  }),
  z.strictObject({
    code: z.literal('storage_capacity_unavailable'),
    scope: z.literal('volume:0'),
    message: z.literal('无法读取媒体卷容量'),
  }),
]);

// 校验后端构建版本字符串，允许 Cargo 版本号的预发布与构建标识。
const overviewApplicationVersion = z.string().regex(
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
);

// 校验系统概览的完整 DTO，并供 MCP 发布同一成功结果结构。
export const getSystemOverviewOutput = z.strictObject({
  sampled_at: z.iso.datetime({ offset: true }),
  application_version: overviewApplicationVersion,
  status: z.enum(['healthy', 'attention']),
  counts: z.strictObject({
    movies: overviewLifecycleCounts,
    series: overviewLifecycleCounts,
    episodes: overviewLifecycleCounts,
    viewer_users: overviewCount,
    active_viewer_users: overviewCount,
    posters: overviewAssetCounts,
    videos: overviewAssetCounts,
  }),
  volumes: z.tuple([overviewVolume]),
  backup: z.strictObject({ status: z.literal('unverifiable') }),
  warnings: z.array(overviewWarning),
}).refine(({ volumes: [volume], warnings }) => {
  // 后端只在卷 0 容量采样失败时提供该告警，校验两者是否一致。
  const unavailable = volume.status === 'unavailable';
  const hasCapacityWarning = warnings.some(warning => warning.code === 'storage_capacity_unavailable');
  return unavailable === hasCapacityWarning;
}, {
  message: '媒体卷容量状态与不可用告警不一致',
  path: ['warnings'],
});
