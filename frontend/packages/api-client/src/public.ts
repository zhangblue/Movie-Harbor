import { apiPath, apiRequest } from "./http";
import type { CatalogKind, CatalogPage, MovieDetail, SeriesDetail } from "./types";

export interface CatalogQuery { kind?: CatalogKind; q?: string; page?: number; size?: number }

export async function listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  return required(await apiRequest<CatalogPage>("/api/catalog", {
    query: { kind: query.kind, q: query.q, page: query.page, size: query.size },
  }));
}
export async function getMovieDetail(id: string): Promise<MovieDetail> {
  return required(await apiRequest<MovieDetail>(apiPath("catalog", "movies", id)));
}
export async function getSeriesDetail(id: string): Promise<SeriesDetail> {
  return required(await apiRequest<SeriesDetail>(apiPath("catalog", "series", id)));
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected an API response body");
  return value;
}
