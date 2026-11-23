import type { CatalogFacets, CatalogKind } from "@movie-harbor/api-client";
import { useEffect, useRef, useState } from "react";
import type { BrowseState } from "./browseUrl";

// 浏览筛选器接收 URL 状态、独立 facets 状态和导航回调，不持久化另一份筛选值。
interface BrowseFiltersProps {
  state: BrowseState;
  authenticated: boolean;
  facets: CatalogFacets | undefined;
  facetsLoading: boolean;
  facetsError: boolean;
  onRetryFacets: () => void;
  onChange: (changes: Partial<BrowseState>) => void;
}

// 渲染桌面侧栏和移动抽屉共用的完整浏览筛选控件。
export function BrowseFilters({
  state, authenticated, facets, facetsLoading, facetsError, onRetryFacets, onChange,
}: BrowseFiltersProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // 抽屉状态切换后移动焦点，防止键盘用户落在不可见控件上。
  useEffect(() => {
    if (open) closeRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const kinds: Array<[CatalogKind, string]> = [["all", "全部"], ["movie", "电影"], ["series", "剧集"]];

  return <>
    <button ref={triggerRef} className="pill browse-filter-trigger" type="button" aria-expanded={open}
      aria-controls="browse-filters" onClick={() => setOpen(true)}>筛选</button>
    <aside id="browse-filters" className={`browse-filters${open ? " is-open" : ""}`} aria-label="浏览筛选">
      <div className="browse-filters__heading">
        <h2>筛选</h2>
        <button ref={closeRef} className="pill browse-filter-close" type="button" onClick={() => setOpen(false)}>关闭筛选</button>
      </div>
      <label className="browse-field">
        <span>关键词</span>
        <input aria-label="浏览关键词" type="search" value={state.query}
          onChange={(event) => onChange({ query: event.target.value })} />
      </label>
      <fieldset className="browse-field">
        <legend>内容类型</legend>
        <div className="kind-switch">
          {kinds.map(([kind, label]) => <button key={kind} className={`pill${state.kind === kind ? " is-active" : ""}`}
            type="button" aria-pressed={state.kind === kind} onClick={() => onChange({ kind })}>{label}</button>)}
        </div>
      </fieldset>
      {facetsError ? <section className="browse-facets-error" role="alert" aria-label="筛选项加载失败">
        <p>题材和年份加载失败。</p><button className="pill" type="button" onClick={onRetryFacets}>重试筛选项</button>
      </section> : facets ? <>
        <fieldset className="browse-field">
          <legend>题材</legend>
          <div className="browse-options">
            {facets.genres.map((genre) => <label key={genre.id}>
              <input type="checkbox" checked={state.genres.includes(genre.id)} onChange={(event) => onChange({
                genres: event.target.checked
                  ? [...state.genres, genre.id]
                  : state.genres.filter((id) => id !== genre.id),
              })} />
              <span>{genre.name}</span>
            </label>)}
          </div>
        </fieldset>
        <label className="browse-field">
          <span>年份</span>
          <select aria-label="年份" value={state.year ?? ""} onChange={(event) => onChange({
            year: event.target.value ? Number(event.target.value) : undefined,
          })}>
            <option value="">全部年份</option>
            {facets.years.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </label>
      </> : facetsLoading ? <p className="browse-facets-loading" role="status">正在加载筛选项…</p> : null}
      {authenticated && <label className="private-only-filter browse-private-filter">
        <input type="checkbox" checked={state.privateOnly}
          onChange={(event) => onChange({ privateOnly: event.target.checked })} />
        <span>只看私密</span>
      </label>}
    </aside>
  </>;
}
