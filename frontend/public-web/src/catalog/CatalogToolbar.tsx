import type { CatalogKind } from "@movie-harbor/api-client";

export function CatalogToolbar({ kind, query, onKindChange, onQueryChange }: {
  kind: CatalogKind; query: string; onKindChange: (kind: CatalogKind) => void; onQueryChange: (query: string) => void;
}) {
  return <div className="catalog-tools">
    <div className="kind-switch" role="group" aria-label="内容形态">
      {([['all', '全部'], ['movie', '电影'], ['series', '剧集']] as const).map(([value, label]) => (
        <button key={value} className={`pill${kind === value ? " is-active" : ""}`} type="button"
          aria-pressed={kind === value} onClick={() => onKindChange(value)}>{label}</button>
      ))}
    </div>
    <label className="search-box">
      <span className="sr-only">搜索电影或剧集</span>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z" /></svg>
      <input type="search" placeholder="搜索电影或剧集" autoComplete="off" value={query} onChange={(event) => onQueryChange(event.target.value)} />
    </label>
  </div>;
}
