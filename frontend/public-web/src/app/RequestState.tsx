import { ApiError } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";

// 由公开页面渲染不存在或不可访问内容的提示。
export function NotFound() {
  return <section className="empty-state"><h1>404 · 内容不存在</h1><p>未找到此内容。</p><a className="back-link" href="/">返回首页</a></section>;
}
// 由公开页面在请求未完成时渲染加载提示。
export function Loading() {
  return <p className="empty-state" role="status">正在加载…</p>;
}
// 由公开页面在请求失败时展示错误及重试入口。
export function RequestError({ error, retry }: { error: Error; retry: () => void }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  return <section className="empty-state"><p role="alert">加载失败，请稍后重试。</p><Button onClick={retry}>重试</Button></section>;
}
