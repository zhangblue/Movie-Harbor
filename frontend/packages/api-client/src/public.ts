import { apiPath, apiRequest, requiredResponse } from "./http";
import type { CatalogKind, CatalogPage, MovieDetail, SeriesDetail } from "./types";

export interface CatalogQuery { kind?: CatalogKind; q?: string; page?: number; size?: number }

export async function listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  return requiredResponse(await apiRequest<CatalogPage>("/api/catalog", {
    query: { kind: query.kind, q: query.q, page: query.page, size: query.size },
  }));
}
export async function getMovieDetail(id: string): Promise<MovieDetail> {
  return requiredResponse(await apiRequest<MovieDetail>(apiPath("catalog", "movies", id)));
}
export async function getSeriesDetail(id: string): Promise<SeriesDetail> {
  return requiredResponse(await apiRequest<SeriesDetail>(apiPath("catalog", "series", id)));
}
