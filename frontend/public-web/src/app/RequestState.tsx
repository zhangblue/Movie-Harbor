import { ApiError } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";

export function NotFound() {
  return <section className="empty-state"><h1>404 · 内容不存在</h1><p>未找到此内容。</p><a className="back-link" href="/">返回首页</a></section>;
}
export function Loading() {
  return <p className="empty-state" role="status">正在加载…</p>;
}
export function RequestError({ error, retry }: { error: Error; retry: () => void }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  return <section className="empty-state"><p role="alert">加载失败，请稍后重试。</p><Button onClick={retry}>重试</Button></section>;
}
