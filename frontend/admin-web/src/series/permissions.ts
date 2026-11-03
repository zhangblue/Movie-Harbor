import type { EpisodeResponse, SeasonResponse, SeriesResponse } from "@movie-harbor/api-client";

export const statusNames: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
// 识别受支持的生命周期状态，在决定是否开放写入前调用。
export const knownStatus = (status: string) => ["draft", "published", "archived"].includes(status);
// Current endpoints return states, not permission objects. If a future response supplies
// permissions, intersect them with the domain constraints; unknown values never grant access.
// 检查服务端返回的操作权限，在渲染和执行层级操作时调用。
export function permits(value: object, action: string) {
  if (!("allowed_actions" in value)) return true;
  return Array.isArray(value.allowed_actions) && value.allowed_actions.includes(action);
}
// 结合生命周期和权限判断内容操作，在展示或执行操作前调用。
export function canAct(value: SeriesResponse | EpisodeResponse, action: "edit" | "publish" | "archive" | "draft" | "delete") {
  const states = { edit: ["draft"], publish: ["draft", "archived"], archive: ["published"], draft: ["archived"], delete: ["draft", "archived"] };
  return states[action].includes(value.status) && permits(value, action);
}
// 判断季是否允许修改或删除，在季操作前调用。
export function canChangeSeason(series: SeriesResponse, season: SeasonResponse, action: "edit" | "delete") {
  return knownStatus(series.status) && season.episodes.every((e) => e.status === "draft" || e.status === "archived") && permits(season, action);
}
