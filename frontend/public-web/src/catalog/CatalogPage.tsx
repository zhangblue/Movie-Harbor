import { useCallback, useEffect, useRef } from "react";
import { listCatalog, type CatalogKind } from "@movie-harbor/api-client";
import { Brand } from "../app/Brand";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { CatalogGrid } from "./CatalogGrid";
import { CatalogPagination } from "./CatalogPagination";
import { CatalogToolbar } from "./CatalogToolbar";

export function CatalogPage({ search, navigate }: { search: string; navigate: (href: string, replace?: boolean) => void }) {
  const params = new URLSearchParams(search);
  const rawKind = params.get("kind");
  const kind: CatalogKind = rawKind === "movie" || rawKind === "series" ? rawKind : "all";
  const query = params.get("q") ?? "";
  const rawPage = Number(params.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const load = useCallback(() => listCatalog({ kind, q: query, page, size: 20 }), [kind, query, page]);
  const { state, retry } = usePublicRequest(load);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusAfterLoad = useRef(false);
  const title = kind === "movie" ? "电影" : kind === "series" ? "剧集" : "全部影片";

  const update = useCallback((next: { kind?: CatalogKind; q?: string; page?: number }, replace = false) => {
    const updated = new URLSearchParams();
    const nextKind = next.kind ?? kind;
    const nextQuery = next.q ?? query;
    const nextPage = next.page ?? 1;
    if (nextKind !== "all") updated.set("kind", nextKind);
    if (nextQuery) updated.set("q", nextQuery);
    if (nextPage !== 1) updated.set("page", String(nextPage));
    const encoded = updated.toString();
    if (next.page !== undefined && next.page !== page) focusAfterLoad.current = true;
    navigate(encoded ? `/?${encoded}` : "/", replace);
  }, [kind, query, page, navigate]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const totalPages = Math.max(1, Math.ceil(state.data.total / state.data.size));
    if (page > totalPages) {
      update({ page: totalPages }, true);
      return;
    }
    if (focusAfterLoad.current) {
      focusAfterLoad.current = false;
      titleRef.current?.focus();
    }
  }, [state, page, update]);

  const correctingPage = state.status === "ready"
    && page > Math.max(1, Math.ceil(state.data.total / state.data.size));
  const loading = state.status === "loading" || correctingPage;

  return <>
    <header className="public-header">
      <Brand />
      <CatalogToolbar kind={kind} query={query} onKindChange={(value) => update({ kind: value })}
        onQueryChange={(value) => update({ q: value }, true)} />
    </header>
    <section aria-labelledby="catalog-title" aria-busy={loading}>
      <div className="section-heading">
        <div><p className="eyebrow">LIBRARY</p><h1 id="catalog-title" ref={titleRef} tabIndex={-1}>{title}</h1></div>
        <p className="result-count" aria-live="polite">{state.status === "ready" && !correctingPage ? `${state.data.total} 部影片` : ""}</p>
      </div>
      {loading ? <><Loading /><div className="pagination-slot" /></>
        : state.status === "error" ? <><RequestError error={state.error} retry={retry} /><div className="pagination-slot" /></> : <>
        {state.data.items.length > 0 ? <CatalogGrid items={state.data.items} /> :
          <div className="empty-state"><strong>没有找到匹配内容</strong><p>换个名称，或切换内容类型再试试。</p></div>}
        <div className="pagination-slot">
          {(state.data.total > state.data.size || page > 1) && <CatalogPagination page={page}
            size={state.data.size} total={state.data.total} disabled={false} onPage={(target) => update({ page: target })} />}
        </div>
      </>}
    </section>
  </>;
}
