import { ValidationFieldList } from "../content/ValidationFieldList";

const labels: Record<string, string> = { name: "名称", video: "可播放视频", genres: "题材", year: "年份", duration_seconds: "时长" };
// 展示电影发布校验失败的字段，供管理员修正草稿。
export function PublishErrors({ fields }: { fields: string[] }) {
  return <ValidationFieldList fields={fields.filter((field) => field !== "poster")} labels={labels} />;
}
