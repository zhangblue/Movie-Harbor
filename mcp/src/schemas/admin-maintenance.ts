import { z } from 'zod';
import { confirmed, id, nextActions, status, version } from './common.js';
import { apiEpisodeEnvelope, apiSeries } from './content.js';

// 限定访问范围操作可使用的顶层内容类型。
const topLevelContentType = z.enum(['movie', 'series']);
// 限定访问范围操作必须显式指定公开或私密。
const visibility = z.enum(['public', 'private']);
// 将请求 UUID 转成后端使用的小写格式，便于核对响应归属。
const requestId = id.toLowerCase();
// 为已确认的维护操作复用内容标识、乐观版本和独立确认字段。
const maintenanceFields = { content_id: requestId, version, confirmed };

// 只接受明确确认、携带版本的电影或整剧访问范围修改。
export const setContentVisibilityInput = z.strictObject({
  ...maintenanceFields,
  content_type: topLevelContentType,
  visibility,
});

// 转换生命周期时严格区分顶层内容与携带完整归属的单集。
export const transitionContentLifecycleInput = z.discriminatedUnion('content_type', [
  z.strictObject({ ...maintenanceFields, content_type: z.literal('movie'), target_status: status }),
  z.strictObject({ ...maintenanceFields, content_type: z.literal('series'), target_status: status }),
  z.strictObject({
    ...maintenanceFields,
    content_type: z.literal('episode'),
    series_id: requestId,
    season_id: requestId,
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
