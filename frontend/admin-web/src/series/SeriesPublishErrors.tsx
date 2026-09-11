const labels: Record<string, string> = { name: "名称", poster: "海报", video: "可播放视频", published_episode: "至少一个已发布单集", episodes: "至少一个已发布单集", number: "集序号", season_number: "季序号", episode_number: "集序号", year: "年份", duration_seconds: "时长" };
export function SeriesPublishErrors({ fields }: { fields: string[] }) {
  return <div role="alert" className="error-message"><p>请检查以下缺失项或错误字段：</p><ul>{fields.map((field) => <li key={field}>{labels[field] ?? field}</li>)}</ul></div>;
}
