import type { EpisodeResponse, SeasonResponse, SeriesResponse } from "@movie-harbor/api-client";

export const statusNames: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
export const knownStatus = (status: string) => ["draft", "published", "archived"].includes(status);
// Current endpoints return states, not permission objects. If a future response supplies
// permissions, intersect them with the domain constraints; unknown values never grant access.
export function permits(value: object, action: string) {
  if (!("allowed_actions" in value)) return true;
  return Array.isArray(value.allowed_actions) && value.allowed_actions.includes(action);
}
export function canAct(value: SeriesResponse | EpisodeResponse, action: "edit" | "publish" | "archive" | "draft" | "delete") {
  const states = { edit: ["draft"], publish: ["draft", "archived"], archive: ["published"], draft: ["archived"], delete: ["draft", "archived"] };
  return states[action].includes(value.status) && permits(value, action);
}
export function canChangeSeason(series: SeriesResponse, season: SeasonResponse, action: "edit" | "delete") {
  return knownStatus(series.status) && season.episodes.every((e) => e.status === "draft" || e.status === "archived") && permits(season, action);
}
