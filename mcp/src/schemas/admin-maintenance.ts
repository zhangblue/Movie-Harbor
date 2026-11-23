import { z } from 'zod';
import { confirmed, id, nextActions, positiveInt, status, version } from './common.js';
import { apiEpisodeEnvelope, apiMovie, apiSeries } from './content.js';
import { validatePosterInput, validatePosterOutput } from './media.js';

// 限定访问范围和海报操作可使用的顶层内容类型。
const topLevelContentType = z.enum(['movie', 'series']);
// 限定访问范围操作必须显式指定公开或私密。
const visibility = z.enum(['public', 'private']);
// 统一维护请求和上传资产的 UUID 为小写，便于核对响应归属和新旧资产。
const canonicalId = id.toLowerCase();
// 为已确认的维护操作复用内容标识、乐观版本和独立确认字段。
const maintenanceFields = { content_id: canonicalId, version, confirmed };

// 只接受明确确认、携带版本的电影或整剧访问范围修改。
export const setContentVisibilityInput = z.strictObject({
  ...maintenanceFields,
  content_type: topLevelContentType,
  visibility,
});

// 只接受明确确认、携带版本和绝对本地路径的电影或整剧海报写入。
export const setContentPosterInput = z.strictObject({
  ...maintenanceFields,
  content_type: topLevelContentType,
  path: validatePosterInput.shape.path,
});

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
  z.strictObject({ ...maintenanceFields, content_type: z.literal('movie'), target_status: status }),
  z.strictObject({ ...maintenanceFields, content_type: z.literal('series'), target_status: status }),
  z.strictObject({
    ...maintenanceFields,
    content_type: z.literal('episode'),
    series_id: canonicalId,
    season_id: canonicalId,
    target_status: status,
  }),
]);

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
