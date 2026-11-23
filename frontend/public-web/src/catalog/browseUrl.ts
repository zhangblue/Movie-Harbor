import type { CatalogKind, CatalogSort } from "@movie-harbor/api-client";

// 表示从浏览 URL 恢复出的完整、已校验筛选状态。
export interface BrowseState {
  kind: CatalogKind;
  query: string;
  genres: string[];
  year: number | undefined;
  privateOnly: boolean;
  sort: CatalogSort;
  page: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sorts = new Set<CatalogSort>(["recent", "year_desc", "year_asc", "name_asc"]);

// 解析、规范化并限制 URL 题材列表，供请求前阻止无效参数进入后端。
function parseGenres(value: string | null, availableGenres?: ReadonlySet<string>) {
  const genres = (value ?? "")
    .split(",")
    .map((genre) => genre.toLowerCase())
    .filter((genre) => uuidPattern.test(genre))
    .filter((genre) => !availableGenres || availableGenres.has(genre));
  return [...new Set(genres)].sort().slice(0, 20);
}

// 从查询字符串读取规范浏览状态，并按当前身份及可用 facets 清理失效条件。
export function parseBrowseUrl(
  search: string,
  authenticated: boolean,
  availableGenres?: ReadonlySet<string>,
): BrowseState {
  const params = new URLSearchParams(search);
  const rawKind = params.get("kind");
  const kind: CatalogKind = rawKind === "movie" || rawKind === "series" ? rawKind : "all";
  const query = (params.get("q") ?? "").trim();
  const rawYear = Number(params.get("year"));
  const year = Number.isInteger(rawYear) && rawYear >= 1 && rawYear <= 9999 ? rawYear : undefined;
  const rawSort = params.get("sort") as CatalogSort | null;
  const sort: CatalogSort = rawSort && sorts.has(rawSort) ? rawSort : "recent";
  const rawPage = Number(params.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  return {
    kind,
    query,
    genres: parseGenres(params.get("genres"), availableGenres),
    year,
    privateOnly: authenticated && params.get("privacy") === "private",
    sort,
    page,
  };
}

// 将浏览状态与一次交互合成为指定入口的规范 URL；只有单独翻页会保留目标页码。
export function buildBrowseUrl(
  state: BrowseState,
  changes: Partial<BrowseState>,
  basePath: "/" | "/browse" = "/browse",
): string {
  const changedFilters = Object.keys(changes).some((key) => key !== "page");
  const next: BrowseState = {
    ...state,
    ...changes,
    page: changedFilters ? 1 : (changes.page ?? state.page),
  };
  const params = new URLSearchParams();
  if (next.kind !== "all") params.set("kind", next.kind);
  if (next.query) params.set("q", next.query.trim());
  if (next.genres.length) params.set("genres", [...new Set(next.genres)].sort().join(","));
  if (next.year !== undefined) params.set("year", String(next.year));
  if (next.privateOnly) params.set("privacy", "private");
  if (next.sort !== "recent") params.set("sort", next.sort);
  if (next.page !== 1) params.set("page", String(next.page));
  const encoded = params.toString();
  return encoded ? `${basePath}?${encoded}` : basePath;
}
