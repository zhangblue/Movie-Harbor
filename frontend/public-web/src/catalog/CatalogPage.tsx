import type { CatalogPage as CatalogPageData } from "@movie-harbor/api-client";
import type { RefObject } from "react";
import { Loading, RequestError } from "../app/RequestState";
import { CatalogGrid } from "./CatalogGrid";
import { CatalogPagination } from "./CatalogPagination";

// 共享目录结果边界只负责加载、错误、空状态、网格和分页，不再拥有 URL 或请求状态。
export function CatalogPage({
  data, loading, error, retry, page, onPage, filtered, privateOnly, onClear, titleRef,
}: {
  data: CatalogPageData | undefined;
  loading: boolean;
  error: Error | undefined;
  retry: () => void;
  page: number;
  onPage: (page: number) => void;
  filtered: boolean;
  privateOnly: boolean;
  onClear: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const pageInRange = page <= totalPages;
  const correctingResult = Boolean(data && data.page > totalPages);
  return <section className="browse-results" aria-labelledby="browse-results-title" aria-busy={loading}>
    <div className="section-heading browse-results__heading">
      <div><p className="eyebrow">LIBRARY</p><h1 id="browse-results-title" ref={titleRef} tabIndex={-1}>浏览影片</h1></div>
      <p className="result-count" aria-live="polite">{data ? `${data.total} 部影片` : ""}</p>
    </div>
    {((!data || !pageInRange) && loading) || correctingResult ? <><Loading /><div className="pagination-slot" /></>
      : !data && error ? <><RequestError error={error} retry={retry} /><div className="pagination-slot" /></>
        : data && pageInRange ? <>
          {error && <section className="inline-request-error" role="alert"><span>更新结果失败，仍显示上次结果。</span><button className="pill" type="button" onClick={retry}>重试目录</button></section>}
          {data.items.length > 0 ? <CatalogGrid items={data.items} />
            : <div className="empty-state"><strong>{privateOnly ? "没有找到私密内容" : "没有找到匹配内容"}</strong><p>调整条件，或清除筛选后再试。</p>
              {filtered && <button className="pill" type="button" onClick={onClear}>清除筛选</button>}
            </div>}
          <div className="pagination-slot">
            {pageInRange && (data.total > data.size || page > 1) && <CatalogPagination page={page} size={data.size}
              total={data.total} disabled={loading} onPage={onPage} />}
          </div>
        </> : null}
  </section>;
}
