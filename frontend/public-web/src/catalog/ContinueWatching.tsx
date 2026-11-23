import { useEffect, useState } from "react";
import { ApiError, getMovieDetail, getSeriesDetail } from "@movie-harbor/api-client";
import { useViewer } from "../auth/ViewerContext";
import { listContinueWatching, markProgressRemoved, type ContinueWatchingEntry } from "../player/progressStore";
import { orderedPlayableEpisodes } from "../series/ordering";

// 保存已通过详情接口确认的首页卡片及其播放目标。
interface ResumeCard {
  href: string;
  name: string;
  poster: string | null;
  label: string;
  percent: number;
  isPrivate: boolean;
  targetKind: "movie" | "series";
  targetId: string;
}

// 首页加载时检查候选影片或确切单集是否仍可播放。
async function loadCard(entry: ContinueWatchingEntry): Promise<ResumeCard | undefined> {
  const id = encodeURIComponent(entry.id);
  const percent = Math.round(entry.progress.position / entry.progress.duration * 100);
  if (entry.kind === "movie") {
    const movie = await getMovieDetail(entry.id);
    if (movie.video_url) {
      return { href: `/movies/${id}/play?resume=1`, name: movie.name, poster: movie.poster_url, label: "电影", percent, isPrivate: movie.is_private, targetKind: "movie", targetId: entry.id };
    }
    return;
  }

  const series = await getSeriesDetail(entry.id);
  const episodes = orderedPlayableEpisodes(series.seasons);
  const currentIndex = episodes.findIndex(({ id }) => id === entry.episodeId);
  const episode = entry.progress.completed ? episodes[currentIndex + 1] : episodes[currentIndex];
  if (episode) {
    return {
      href: `/series/${id}/play/${encodeURIComponent(episode.id)}?resume=1`,
      name: series.name,
      poster: series.poster_url,
      label: `第 ${episode.seasonNumber} 季 · 第 ${episode.number} 集`,
      percent: entry.progress.completed ? 0 : percent,
      isPrivate: series.is_private,
      targetKind: "series",
      targetId: entry.id,
    };
  }
}

// 登录用户进入无筛选首页时展示当前仍可访问的续播条目。
export function ContinueWatching({ viewerId }: { viewerId: string }) {
  const { validate, expire, syncProgress } = useViewer();
  const [cards, setCards] = useState<ResumeCard[]>([]);
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    // 先确认账号会话，再按观看时间检查候选；旧身份的请求完成后丢弃。
    const load = async () => {
      if (!(await validate()) || cancelled) return;
      await syncProgress();
      if (cancelled) return;
      const available: ResumeCard[] = [];
      for (const entry of listContinueWatching(viewerId)) {
        try {
          const card = await loadCard(entry);
          if (cancelled) return;
          if (card) available.push(card);
          if (available.length === 6) break;
        } catch (error) {
          if (cancelled) return;
          // 会话明确失效时交给根组件退出，其他单项故障由目录继续展示。
          if (error instanceof ApiError && error.status === 401) {
            expire();
            return;
          }
        }
      }
      if (!cancelled) setCards(available);
    };
    void load();
    return () => { cancelled = true; };
  }, [viewerId, validate, expire, syncProgress]);

  // 用户移除卡片时先写本地墓碑并同步；失败则恢复原快照以便重试。
  const remove = async (card: ResumeCard) => {
    setRemoving(card.href); setError("");
    markProgressRemoved(card.targetKind, card.targetId, undefined, viewerId);
    if (await syncProgress()) setCards((current) => current.filter((item) => item.href !== card.href));
    else {
      setError(`移除“${card.name}”失败，请重试。`);
    }
    setRemoving(undefined);
  };

  if (!cards.length) return null;
  return <section className="continue-watching" aria-labelledby="continue-watching-title">
    <div className="section-heading"><h2 id="continue-watching-title">继续观看</h2></div>
    {error && <p className="viewer-error" role="alert">{error}</p>}
    <ul className="catalog-grid catalog-grid--five">
      {cards.map((card) => <li key={card.href}>
        <a className="mh-poster-card" href={card.href}>
          <div className="mh-poster-card__frame">
            {card.poster ? <img src={card.poster} alt="" loading="lazy" /> : <div className="poster-blank" aria-hidden="true" />}
          </div>
          <div className="mh-poster-card__copy">
            <h3 className="mh-poster-card__title">{card.name}</h3>
            <p className="mh-poster-card__meta">{card.label} · 已观看 {card.percent}%</p>
          </div>
        </a>
        <button type="button" className="continue-watching__remove" aria-label={`移除${card.name}`} disabled={removing === card.href} onClick={() => { void remove(card); }}>移除</button>
        {card.isPrivate && <span className="privacy-badge">私密</span>}
      </li>)}
    </ul>
  </section>;
}
