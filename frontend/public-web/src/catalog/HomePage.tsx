import { listCatalog } from "@movie-harbor/api-client";
import { useCallback, type ReactNode } from "react";
import { Brand } from "../app/Brand";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { useViewer } from "../auth/ViewerContext";
import { CatalogGrid } from "./CatalogGrid";
import { CatalogToolbar } from "./CatalogToolbar";
import { ContinueWatching } from "./ContinueWatching";

// 渲染简洁首页，将续播入口置于最近添加之前，并把完整发现能力交给浏览页。
export function HomePage({ navigate, account }: {
  navigate: (href: string, replace?: boolean) => void;
  account?: ReactNode;
}) {
  const { authenticated, viewerId, revision } = useViewer();
  // 身份代次变化后重新读取最近内容，保证登录可见范围立即生效。
  const load = useCallback(
    () => listCatalog({ sort: "recent", page: 1, size: 20 }),
    [revision],
  );
  const { state, retry } = usePublicRequest(load);
  const items = state.status === "ready"
    ? state.data.items.filter((item) => authenticated || !item.is_private)
    : [];

  return <>
    <header className="public-header">
      <Brand />
      <CatalogToolbar navigate={navigate} />
      {account}
    </header>
    {authenticated && viewerId && <ContinueWatching key={`${viewerId}:${revision}`} viewerId={viewerId} />}
    <section className="recent-catalog" aria-labelledby="recent-catalog-title" aria-busy={state.status === "loading"}>
      <div className="section-heading">
        <div><p className="eyebrow">RECENT</p><h1 id="recent-catalog-title">最近添加</h1></div>
        <a className="browse-all-link" href="/browse">浏览全部</a>
      </div>
      {state.status === "loading" ? <Loading />
        : state.status === "error" ? <RequestError error={state.error} retry={retry} />
          : items.length > 0 ? <CatalogGrid items={items} />
            : <div className="empty-state"><strong>没有找到匹配内容</strong><p>当前还没有可浏览的已发布内容。</p></div>}
    </section>
  </>;
}
