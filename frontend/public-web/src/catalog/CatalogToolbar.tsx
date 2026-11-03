import type { CatalogKind } from "@movie-harbor/api-client";

// 由目录页渲染内容筛选与搜索控件。
export function CatalogToolbar({ kind, query, authenticated, privateOnly, onKindChange, onQueryChange, onPrivateOnlyChange }: {
  kind: CatalogKind; query: string; authenticated: boolean; privateOnly: boolean;
  onKindChange: (kind: CatalogKind) => void; onQueryChange: (query: string) => void;
  onPrivateOnlyChange: (privateOnly: boolean) => void;
}) {
  return <div className="catalog-tools">
    <div className="kind-switch" role="group" aria-label="内容形态">
      {([['all', '全部'], ['movie', '电影'], ['series', '剧集']] as const).map(([value, label]) => (
        <button key={value} className={`pill${kind === value ? " is-active" : ""}`} type="button"
          aria-pressed={kind === value} onClick={() => onKindChange(value)}>{label}</button>
      ))}
    </div>
    {authenticated && <label className="private-only-filter">
      <input type="checkbox" checked={privateOnly} onChange={(event) => onPrivateOnlyChange(event.target.checked)} />
      <span>只看私密</span>
    </label>}
    <label className="search-box">
      <span className="sr-only">搜索电影或剧集</span>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z" /></svg>
      <input type="search" placeholder="搜索电影或剧集" autoComplete="off" value={query} onChange={(event) => onQueryChange(event.target.value)} />
    </label>
  </div>;
}
