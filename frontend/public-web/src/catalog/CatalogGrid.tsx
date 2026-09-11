import type { CatalogCard } from "@movie-harbor/api-client";
import { PosterCard } from "@movie-harbor/ui";

export function CatalogGrid({ items }: { items: CatalogCard[] }) {
  return <ul className="catalog-grid catalog-grid--five" aria-label="影片目录">
    {items.map((item) => <li key={`${item.kind}:${item.id}`}>
      <PosterCard href={`/${item.kind === "movie" ? "movies" : "series"}/${encodeURIComponent(item.id)}`}
        title={item.name} kind={item.kind} year={item.year} posterUrl={item.poster_url}
        genres={item.genres} genreCount={item.genre_count} />
    </li>)}
  </ul>;
}
