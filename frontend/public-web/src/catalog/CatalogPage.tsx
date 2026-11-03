import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useViewer } from "../auth/ViewerContext";
import { listCatalog, type CatalogKind } from "@movie-harbor/api-client";
import { Brand } from "../app/Brand";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { CatalogGrid } from "./CatalogGrid";
import { CatalogPagination } from "./CatalogPagination";
import { CatalogToolbar } from "./CatalogToolbar";

// 由应用首页渲染目录，协调筛选、请求、分页和焦点。
export function CatalogPage({ search, navigate, account }: { search: string; navigate: (href: string, replace?: boolean) => void; account?: ReactNode }) {
  const { authenticated, discoveryPending } = useViewer();
  const params = new URLSearchParams(search);
  const rawKind = params.get("kind");
  const kind: CatalogKind = rawKind === "movie" || rawKind === "series" ? rawKind : "all";
  const query = params.get("q") ?? "";
  const privateOnly = params.get("privacy") === "private";
  const rawPage = Number(params.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  // 让请求随筛选和页码变化重新执行，服务端返回的数据决定当前目录内容。
  const load = useCallback(() => listCatalog({ kind, q: query, privacy: privateOnly ? "private" : undefined, page, size: 20 }), [kind, query, privateOnly, page]);
  const { state, retry } = usePublicRequest(load);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusAfterLoad = useRef(false);
  const wasAuthenticated = useRef(authenticated);
  const title = kind === "movie" ? "电影" : kind === "series" ? "剧集" : "全部影片";

  // 筛选或分页变化时更新目录 URL，并在换页后安排焦点恢复。
  const update = useCallback((next: { kind?: CatalogKind; q?: string; privateOnly?: boolean; page?: number }, replace = false) => {
    const updated = new URLSearchParams();
    const nextKind = next.kind ?? kind;
    const nextQuery = next.q ?? query;
    const nextPrivateOnly = next.privateOnly ?? privateOnly;
    const nextPage = next.page ?? 1;
    if (nextKind !== "all") updated.set("kind", nextKind);
    if (nextQuery) updated.set("q", nextQuery);
    if (nextPrivateOnly) updated.set("privacy", "private");
    if (nextPage !== 1) updated.set("page", String(nextPage));
    const encoded = updated.toString();
    if (next.page !== undefined && next.page !== page) focusAfterLoad.current = true;
    navigate(encoded ? `/?${encoded}` : "/", replace);
  }, [kind, query, privateOnly, page, navigate]);

  // 身份确认或退出后去掉匿名用户无权使用的私密筛选，同时重置分页并替换当前历史项。
  useEffect(() => {
    const authenticationLost = wasAuthenticated.current && !authenticated;
    wasAuthenticated.current = authenticated;
    if (!discoveryPending && !authenticated && (privateOnly || authenticationLost)) update({ privateOnly: false }, true);
  }, [authenticated, discoveryPending, privateOnly, update]);

  // 目录结果就绪后校正越界页码；合法换页则恢复标题焦点，方便键盘用户继续浏览。
  useEffect(() => {
    if (state.status !== "ready" || (privateOnly && !authenticated)) return;
    const totalPages = Math.max(1, Math.ceil(state.data.total / state.data.size));
    if (page > totalPages) {
      // 数据缩减导致页码越界时替换地址，随后重新请求最后一页。
      update({ page: totalPages }, true);
      return;
    }
    if (focusAfterLoad.current) {
      focusAfterLoad.current = false;
      titleRef.current?.focus();
    }
  }, [state, page, update, privateOnly, authenticated]);

  const correctingPage = state.status === "ready"
    && page > Math.max(1, Math.ceil(state.data.total / state.data.size));
  const loading = state.status === "loading" || correctingPage || (privateOnly && !authenticated);

  return <>
    <header className="public-header">
      <Brand />
      <CatalogToolbar kind={kind} query={query} authenticated={authenticated} privateOnly={privateOnly}
        onPrivateOnlyChange={(value) => update({ privateOnly: value })} onKindChange={(value) => update({ kind: value })}
        onQueryChange={(value) => update({ q: value }, true)} />
      {account}
    </header>
    <section aria-labelledby="catalog-title" aria-busy={loading}>
      <div className="section-heading">
        <div><p className="eyebrow">LIBRARY</p><h1 id="catalog-title" ref={titleRef} tabIndex={-1}>{title}</h1></div>
        <p className="result-count" aria-live="polite">{state.status === "ready" && !loading ? `${state.data.total} 部影片` : ""}</p>
      </div>
      {loading ? <><Loading /><div className="pagination-slot" /></>
        : state.status === "error" ? <><RequestError error={state.error} retry={retry} /><div className="pagination-slot" /></> : <>
        {state.data.items.length > 0 ? <CatalogGrid items={state.data.items.filter((item) => authenticated || !item.is_private)} /> :
          <div className="empty-state"><strong>{privateOnly ? "没有找到私密内容" : "没有找到匹配内容"}</strong><p>换个名称，或切换内容类型再试试。</p></div>}
        <div className="pagination-slot">
          {(state.data.total > state.data.size || page > 1) && <CatalogPagination page={page}
            size={state.data.size} total={state.data.total} disabled={false} onPage={(target) => update({ page: target })} />}
        </div>
      </>}
    </section>
  </>;
}
