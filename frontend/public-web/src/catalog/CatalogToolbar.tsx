import type { CatalogKind } from "@movie-harbor/api-client";
import { useState, type FormEvent } from "react";

// 首页导航工具栏只生成浏览页链接，不在首页维护目录筛选状态。
function HomeCatalogToolbar({ navigate }: { navigate: (href: string) => void }) {
  const [query, setQuery] = useState("");
  // 提交首页短搜索时去除空白，并将关键词编码进唯一的浏览页 URL。
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    const params = new URLSearchParams();
    if (value) params.set("q", value);
    navigate(params.size ? `/browse?${params}` : "/browse");
  };
  return <div className="catalog-tools catalog-tools--navigation">
    <nav className="kind-switch" aria-label="浏览内容">
      <a className="pill" href="/browse">全部</a>
      <a className="pill" href="/browse?kind=movie">电影</a>
      <a className="pill" href="/browse?kind=series">剧集</a>
    </nav>
    <form className="home-search" role="search" onSubmit={submit}>
      <label className="search-box">
        <span className="sr-only">搜索电影或剧集</span>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z" /></svg>
        <input type="search" placeholder="搜索电影或剧集" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button className="sr-only" type="submit">搜索</button>
    </form>
  </div>;
}

// 保留旧目录任务在浏览页使用的受控属性，下一任务会将其收敛为完整浏览筛选器。
interface LegacyCatalogToolbarProps {
  kind: CatalogKind; query: string; authenticated: boolean; privateOnly: boolean;
  onKindChange: (kind: CatalogKind) => void; onQueryChange: (query: string) => void;
  onPrivateOnlyChange: (privateOnly: boolean) => void;
}

// 首页导航模式只需要站内导航函数。
interface HomeCatalogToolbarProps { navigate: (href: string) => void }

// 由首页或旧目录边界渲染导航式或受控式工具栏。
export function CatalogToolbar(props: LegacyCatalogToolbarProps | HomeCatalogToolbarProps) {
  if ("navigate" in props) return <HomeCatalogToolbar navigate={props.navigate} />;
  const { kind, query, authenticated, privateOnly, onKindChange, onQueryChange, onPrivateOnlyChange } = props;
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
