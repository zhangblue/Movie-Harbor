import { useCallback } from "react";
import { listCatalog, type CatalogKind } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";
import { Brand } from "../app/Brand";
import { Loading, RequestError } from "../app/RequestState";
import { usePublicRequest } from "../app/usePublicRequest";
import { CatalogGrid } from "./CatalogGrid";
import { CatalogToolbar } from "./CatalogToolbar";

export function CatalogPage({ search, navigate }: { search: string; navigate: (href: string, replace?: boolean) => void }) {
  const params = new URLSearchParams(search);
  const rawKind = params.get("kind");
  const kind: CatalogKind = rawKind === "movie" || rawKind === "series" ? rawKind : "all";
  const query = params.get("q") ?? "";
  const rawPage = Number(params.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const load = useCallback(() => listCatalog({ kind, q: query, page, size: 25 }), [kind, query, page]);
  const { state, retry } = usePublicRequest(load);
  const title = kind === "movie" ? "电影" : kind === "series" ? "剧集" : "全部影片";

  function update(next: { kind?: CatalogKind; q?: string; page?: number }, replace = false) {
    const updated = new URLSearchParams();
    const nextKind = next.kind ?? kind;
    const nextQuery = next.q ?? query;
    const nextPage = next.page ?? 1;
    if (nextKind !== "all") updated.set("kind", nextKind);
    if (nextQuery) updated.set("q", nextQuery);
    if (nextPage !== 1) updated.set("page", String(nextPage));
    const encoded = updated.toString();
    navigate(encoded ? `/?${encoded}` : "/", replace);
  }

  return <>
    <header className="public-header">
      <Brand />
      <CatalogToolbar kind={kind} query={query} onKindChange={(value) => update({ kind: value })}
        onQueryChange={(value) => update({ q: value }, true)} />
    </header>
    <section aria-labelledby="catalog-title" aria-busy={state.status === "loading"}>
      <div className="section-heading">
        <div><p className="eyebrow">LIBRARY</p><h1 id="catalog-title">{title}</h1></div>
        <p className="result-count" aria-live="polite">{state.status === "ready" ? `${state.data.total} 部影片` : ""}</p>
      </div>
      {state.status === "loading" ? <Loading /> : state.status === "error" ? <RequestError error={state.error} retry={retry} /> : <>
        {state.data.items.length > 0 ? <CatalogGrid items={state.data.items} /> :
          <div className="empty-state"><strong>没有找到匹配内容</strong><p>换个名称，或切换内容类型再试试。</p></div>}
        {(state.data.total > state.data.size || page > 1) && <nav className="pagination" aria-label="目录分页">
          <Button disabled={page <= 1} onClick={() => update({ page: page - 1 })}>上一页</Button>
          <span>第 {page} 页</span>
          <Button disabled={page * state.data.size >= state.data.total} onClick={() => update({ page: page + 1 })}>下一页</Button>
        </nav>}
      </>}
    </section>
  </>;
}
