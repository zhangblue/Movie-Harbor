const labels: Record<string, string> = { name: "名称", poster: "海报", video: "可播放视频", genres: "题材", year: "年份", duration_seconds: "时长" };
export function PublishErrors({ fields }: { fields: string[] }) {
  return <div role="alert" className="error-message"><p>请检查以下缺失项或错误字段：</p><ul>{fields.map((field) => <li key={field}>{labels[field] ?? field}</li>)}</ul></div>;
}
