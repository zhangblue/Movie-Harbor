import {
  ApiError, listCatalog, listCatalogFacets, normalizeError,
  type CatalogFacets, type CatalogPage as CatalogPageData, type CaughtValue,
} from "@movie-harbor/api-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brand } from "../app/Brand";
import { useViewer } from "../auth/ViewerContext";
import { BrowseFilters } from "./BrowseFilters";
import { CatalogPage } from "./CatalogPage";
import { buildBrowseUrl, parseBrowseUrl, type BrowseState } from "./browseUrl";

// 保存目录请求当前数据、加载和错误状态，以便刷新期间保留旧布局。
interface CatalogRequestState {
  data?: CatalogPageData;
  key?: string;
  loading: boolean;
  error?: Error;
}

// 保存独立 facets 请求状态，失败时不影响目录数据。
interface FacetsRequestState {
  data?: CatalogFacets;
  loading: boolean;
  error?: Error;
}

// 渲染 URL 驱动的完整浏览页，协调独立 facets、目录请求、分页和焦点。
export function BrowsePage({ search, navigate, account, basePath = "/browse" }: {
  search: string;
  navigate: (href: string, replace?: boolean) => void;
  account?: ReactNode;
  basePath?: "/" | "/browse";
}) {
  const { authenticated, discoveryPending, revision, validate, expire } = useViewer();
  const [catalog, setCatalog] = useState<CatalogRequestState>({ loading: true });
  const [facets, setFacets] = useState<FacetsRequestState>({ loading: true });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [facetsAttempt, setFacetsAttempt] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusAfterPage = useRef(false);
  const wasAuthenticated = useRef(authenticated);
  const availableGenres = useMemo(
    () => facets.data ? new Set(facets.data.genres.map((genre) => genre.id.toLowerCase())) : undefined,
    [facets.data],
  );
  const state = parseBrowseUrl(search, authenticated, availableGenres);
  const canonicalHref = buildBrowseUrl(state, {}, basePath);
  const rawHref = search ? `${basePath}${search.startsWith("?") ? search : `?${search}`}` : basePath;
  const pendingPrivateDiscovery = discoveryPending && new URLSearchParams(search).get("privacy") === "private";

  // 身份或 facets 确认后以 replace 清理非法、重复、无权限和不存在的 URL 条件。
  useEffect(() => {
    if (!discoveryPending && rawHref !== canonicalHref) navigate(canonicalHref, true);
  }, [canonicalHref, discoveryPending, navigate, rawHref]);

  // 已登录用户退出或会话失效时重置页码并移除私密条件，避免匿名目录沿用旧身份的分页位置。
  useEffect(() => {
    const authenticationLost = wasAuthenticated.current && !authenticated;
    wasAuthenticated.current = authenticated;
    if (!discoveryPending && authenticationLost) {
      navigate(buildBrowseUrl(state, { privateOnly: false }, basePath), true);
    }
  }, [authenticated, discoveryPending, navigate, state]);

  // 身份代次变化或独立重试时读取 facets，并以清理标记丢弃迟到响应。
  useEffect(() => {
    let ignore = false;
    setFacets((current) => ({ ...current, loading: true, error: undefined }));
    const load = async () => {
      if (authenticated && !(await validate())) return;
      const data = await listCatalogFacets();
      if (!ignore) setFacets({ data, loading: false });
    };
    void load().catch((cause: CaughtValue) => {
      if (ignore) return;
      if (authenticated && cause instanceof ApiError && cause.status === 401) expire();
      else setFacets((current) => ({ ...current, loading: false, error: normalizeError(cause) }));
    });
    return () => { ignore = true; };
  }, [authenticated, expire, facetsAttempt, revision, validate]);

  // URL、身份或重试变化时刷新目录；旧数据保留到新响应成功，迟到响应由清理标记丢弃。
  useEffect(() => {
    if (pendingPrivateDiscovery) return;
    let ignore = false;
    setCatalog((current) => ({ ...current, loading: true, error: undefined }));
    const load = async () => {
      if (authenticated && !(await validate())) return;
      const data = await listCatalog({
        kind: state.kind,
        q: state.query || undefined,
        genres: state.genres,
        year: state.year,
        privacy: state.privateOnly ? "private" : undefined,
        sort: state.sort,
        page: state.page,
        size: 20,
      });
      if (!ignore) setCatalog({ data, key: canonicalHref, loading: false });
    };
    void load().catch((cause: CaughtValue) => {
      if (ignore) return;
      if (authenticated && cause instanceof ApiError && cause.status === 401) expire();
      else setCatalog((current) => ({ ...current, loading: false, error: normalizeError(cause) }));
    });
    return () => { ignore = true; };
  }, [authenticated, canonicalHref, catalogAttempt, expire, pendingPrivateDiscovery, revision, validate]);

  // 当前请求成功后校正越界页；合法翻页则把焦点移回结果标题。
  useEffect(() => {
    if (!catalog.data || catalog.loading || catalog.key !== canonicalHref) return;
    const totalPages = Math.max(1, Math.ceil(catalog.data.total / catalog.data.size));
    if (state.page > totalPages) {
      navigate(buildBrowseUrl(state, { page: totalPages }, basePath), true);
      return;
    }
    if (focusAfterPage.current && catalog.data.page === state.page) {
      focusAfterPage.current = false;
      titleRef.current?.focus();
    }
  }, [canonicalHref, catalog.data, catalog.key, catalog.loading, navigate, state]);

  // 应用一次筛选或分页变化；翻页完成后安排结果标题焦点。
  const change = (changes: Partial<BrowseState>) => {
    if (Object.keys(changes).length === 1 && changes.page !== undefined && changes.page !== state.page) {
      focusAfterPage.current = true;
    }
    navigate(buildBrowseUrl(state, changes, basePath));
  };
  // 清除全部目录条件但保留当前身份，供标签区和空状态复用。
  const clear = () => navigate(basePath);
  const filtered = state.kind !== "all" || Boolean(state.query) || state.genres.length > 0
    || state.year !== undefined || state.privateOnly || state.sort !== "recent";
  const genreNames = new Map(facets.data?.genres.map((genre) => [genre.id, genre.name]) ?? []);

  return <>
    <header className="public-header"><Brand />{account}</header>
    <div className="browse-layout">
      <BrowseFilters state={state} authenticated={authenticated} facets={facets.data}
        facetsLoading={facets.loading} facetsError={Boolean(facets.error)}
        onRetryFacets={() => setFacetsAttempt((value) => value + 1)} onChange={change} />
      <div className="browse-main">
        <div className="browse-sort-row">
          <div className="active-filters" aria-label="当前筛选">
            {state.query && <button className="filter-tag" type="button" aria-label={`移除关键词 ${state.query}`} onClick={() => change({ query: "" })}>关键词：{state.query} ×</button>}
            {state.kind !== "all" && <button className="filter-tag" type="button" aria-label={`移除类型 ${state.kind === "movie" ? "电影" : "剧集"}`} onClick={() => change({ kind: "all" })}>{state.kind === "movie" ? "电影" : "剧集"} ×</button>}
            {state.genres.map((id) => <button key={id} className="filter-tag" type="button" aria-label={`移除题材 ${genreNames.get(id) ?? id}`} onClick={() => change({ genres: state.genres.filter((genre) => genre !== id) })}>题材：{genreNames.get(id) ?? id} ×</button>)}
            {state.year !== undefined && <button className="filter-tag" type="button" aria-label={`移除年份 ${state.year}`} onClick={() => change({ year: undefined })}>年份：{state.year} ×</button>}
            {state.privateOnly && <button className="filter-tag" type="button" aria-label="移除只看私密" onClick={() => change({ privateOnly: false })}>只看私密 ×</button>}
            {filtered && <button className="clear-filters" type="button" onClick={clear}>清除全部</button>}
          </div>
          <label className="browse-sort"><span>排序</span><select value={state.sort}
            onChange={(event) => change({ sort: event.target.value as BrowseState["sort"] })}>
            <option value="recent">最近添加</option><option value="year_desc">年份从新到旧</option>
            <option value="year_asc">年份从旧到新</option><option value="name_asc">名称 A–Z</option>
          </select></label>
        </div>
        <CatalogPage data={catalog.data} loading={catalog.loading || pendingPrivateDiscovery} error={catalog.error}
          retry={() => setCatalogAttempt((value) => value + 1)} page={state.page}
          onPage={(page) => change({ page })} filtered={filtered} privateOnly={state.privateOnly}
          onClear={clear} titleRef={titleRef} />
      </div>
    </div>
  </>;
}
