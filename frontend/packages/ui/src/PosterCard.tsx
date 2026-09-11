import { useEffect, useState } from "react";

export interface PosterCardProps {
  href: string;
  title: string;
  kind: "movie" | "series";
  year: number | null;
  posterUrl?: string | null;
  genres: readonly (string | { name: string })[];
  genreCount?: number;
  className?: string;
}

export function PosterCard({ href, title, kind, year, posterUrl, genres, genreCount, className }: PosterCardProps) {
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => setPosterFailed(false), [posterUrl]);

  const names = genres
    .map((genre) => typeof genre === "string" ? genre : genre.name)
    .map((genre) => genre.trim())
    .filter(Boolean);
  const total = Math.max(names.length, genreCount ?? names.length);
  const badges = total > 3 ? [...names.slice(0, 2), `+${total - 2}`] : names.slice(0, 3);
  const kindName = kind === "movie" ? "电影" : "剧集";

  return (
    <a className={["mh-poster-card", className].filter(Boolean).join(" ")} href={href} aria-label={`查看${title}详情`}>
      <div className="mh-poster-card__frame">
        {posterUrl && !posterFailed ? (
          <img src={posterUrl} alt={`${title}海报`} loading="lazy" onError={() => setPosterFailed(true)} />
        ) : (
          <div className="mh-poster-card__fallback" role="img" aria-label={`${title}海报不可用`}>
            <span aria-hidden="true">MH</span>
          </div>
        )}
      </div>
      <div className="mh-poster-card__copy">
        <h2 className="mh-poster-card__title">{title}</h2>
        <p className="mh-poster-card__meta">{kindName} · {year ?? "年份未知"}</p>
        {badges.length ? (
          <div className="mh-poster-card__genres" aria-label="题材">
            {badges.map((genre, index) => <span className="mh-genre" data-testid="genre-badge" key={`${genre}-${index}`}>{genre}</span>)}
          </div>
        ) : null}
      </div>
    </a>
  );
}
