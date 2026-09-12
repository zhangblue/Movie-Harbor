import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  const suppliedCount = typeof genreCount === "number" && Number.isFinite(genreCount)
    ? Math.max(0, Math.floor(genreCount))
    : names.length;
  const total = Math.max(names.length, suppliedCount);
  const maximumNameCount = Math.min(3, names.length);
  const [measuredNameCount, setMeasuredNameCount] = useState<number | null>(maximumNameCount);
  const visibleNameCount = measuredNameCount === null ? null : Math.min(measuredNameCount, maximumNameCount);
  const genresRef = useRef<HTMLDivElement>(null);
  const measurementsRef = useRef<HTMLDivElement>(null);
  const namesKey = JSON.stringify(names);

  useLayoutEffect(() => {
    setMeasuredNameCount(maximumNameCount);
    if (typeof ResizeObserver === "undefined" || total === 0) return;

    const measure = () => {
      const available = genresRef.current?.getBoundingClientRect().width;
      const candidates = Array.from(
        measurementsRef.current?.querySelectorAll<HTMLElement>("[data-genre-candidate]") ?? [],
      );
      if (available === undefined || !candidates.length) return;
      const widths = candidates.map((candidate) => candidate.getBoundingClientRect().width);
      if (widths.every((width) => width === 0)) return;
      const fitting = candidates
        .map((candidate, index) => ({ count: Number(candidate.dataset.genreCandidate), width: widths[index] ?? 0 }))
        .filter((candidate) => candidate.width <= available)
        .sort((left, right) => right.count - left.count)[0];
      setMeasuredNameCount(fitting?.count ?? null);
    };

    measure();
    const observer = new ResizeObserver(measure);
    if (genresRef.current) observer.observe(genresRef.current);
    return () => observer.disconnect();
  }, [maximumNameCount, namesKey, total]);

  const candidateBadges = (nameCount: number) => {
    const visible = names.slice(0, nameCount);
    const overflow = total - nameCount;
    return overflow > 0 ? [...visible, `+${overflow}`] : visible;
  };
  const badges = visibleNameCount === null ? [] : candidateBadges(visibleNameCount);
  const kindName = kind === "movie" ? "电影" : "剧集";
  const displayedPoster = posterUrl && !posterFailed ? posterUrl : null;

  return (
    <a className={["mh-poster-card", className].filter(Boolean).join(" ")} href={href} aria-label={`查看${title}详情`}>
      <div className={`mh-poster-card__frame${displayedPoster ? "" : " is-blank"}`}>
        {displayedPoster ? (
          <img src={displayedPoster} alt={`${title}海报`} loading="lazy" onError={() => setPosterFailed(true)} />
        ) : (
          <div className="poster-blank" aria-hidden="true" />
        )}
      </div>
      <div className="mh-poster-card__copy">
        <h2 className="mh-poster-card__title">{title}</h2>
        <p className="mh-poster-card__meta">{kindName} · {year ?? "年份未知"}</p>
        {total > 0 ? (
          <>
            <div ref={genresRef} className="mh-poster-card__genres" data-testid="genre-list" aria-label="题材">
              {badges.map((genre, index) => <span className="mh-genre" data-testid="genre-badge" key={`${genre}-${index}`}>{genre}</span>)}
            </div>
            <div ref={measurementsRef} className="mh-poster-card__measurements" data-testid="genre-measurements" aria-hidden="true">
              {Array.from({ length: maximumNameCount + 1 }, (_, nameCount) => (
                <span className="mh-poster-card__candidate" data-genre-candidate={nameCount} key={nameCount}>
                  {candidateBadges(nameCount).map((genre, index) => (
                    <span className="mh-genre" data-measure-chip key={`${genre}-${index}`}>{genre}</span>
                  ))}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </a>
  );
}
