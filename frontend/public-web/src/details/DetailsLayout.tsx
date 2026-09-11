import { useState, type ReactNode } from "react";
import type { MovieDetail, SeriesDetail } from "@movie-harbor/api-client";

export function durationLabel(seconds: number | null) {
  return seconds === null ? "时长未知" : `${Math.ceil(seconds / 60)} 分钟`;
}

export function DetailsLayout({ detail, children }: { detail: MovieDetail | SeriesDetail; children: ReactNode }) {
  const [posterFailed, setPosterFailed] = useState(false);
  return <>
    <a href="/" className="back-link">返回首页</a>
    <article className="detail-layout">
      <div className="detail-poster">
        {detail.poster_url && !posterFailed ? <img src={detail.poster_url} alt={`${detail.name}海报`} onError={() => setPosterFailed(true)} />
          : <div className="poster-fallback" role="img" aria-label={`${detail.name}海报不可用`}>MH</div>}
      </div>
      <div className="detail-copy">
        <p className="eyebrow">{detail.kind === "movie" ? "MOVIE" : "SERIES"}</p>
        <h1>{detail.name}</h1>
        <p className="detail-meta">{detail.kind === "movie" ? "电影" : "剧集"} · {detail.year ?? "年份未知"}
          {detail.kind === "movie" ? ` · ${durationLabel(detail.duration_seconds)}` : ""}</p>
        <div className="detail-genres" aria-label="全部题材">{detail.genres.map((genre) => <span className="mh-genre" key={genre.id}>{genre.name}</span>)}</div>
        <p className="synopsis">{detail.synopsis || "暂无简介。"}</p>
        {children}
      </div>
    </article>
  </>;
}
