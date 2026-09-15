import { ValidationFieldList } from "../content/ValidationFieldList";

const labels: Record<string, string> = { name: "名称", video: "可播放视频", number: "集序号", season_number: "季序号", episode_number: "集序号", year: "年份", duration_seconds: "时长" };
export function SeriesPublishErrors({ fields }: { fields: string[] }) {
  const needsEpisode = fields.some((field) => field === "episodes" || field === "published_episode");
  const remaining = fields.filter((field) => field !== "poster" && field !== "episodes" && field !== "published_episode");
  if (!needsEpisode && remaining.length === 0) return null;
  return <div role="alert" className="error-message">
    {needsEpisode && <p>发布剧集失败：当前剧集没有已发布的单集。请先为单集上传可播放视频并发布至少一集，然后再发布整个剧集。</p>}
    <ValidationFieldList fields={remaining} labels={labels} role={undefined} />
  </div>;
}
