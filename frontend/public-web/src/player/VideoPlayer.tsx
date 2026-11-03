import { useEffect, useRef, useState } from "react";
import { clearProgress, getProgress, saveProgress, type PlaybackContentKey } from "./progressStore";

// 由电影或剧集播放页渲染视频，协调播放状态与本地进度。
export function VideoPlayer({ contentKey, src, title }: {
  contentKey: PlaybackContentKey;
  src: string;
  title: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSavedAt = useRef(Date.now());
  const savedProgress = useRef(getProgress(contentKey));
  const canPersist = useRef(savedProgress.current === null);
  const [resumeChoice, setResumeChoice] = useState<"pending" | "continue" | "start">(
    savedProgress.current ? "pending" : "start",
  );
  const [playbackState, setPlaybackState] = useState<"checking" | "ready" | "error">("checking");

  // 在播放暂停、定期更新或离页时保存进度；用户尚未选择恢复方式时保留旧记录。
  const persist = (video = videoRef.current) => {
    if (!canPersist.current) return;
    if (!video) return;
    saveProgress(contentKey, video.currentTime, video.duration);
    lastSavedAt.current = Date.now();
  };

  // 在元数据可用且选择继续播放时恢复保存位置，并限制在视频时长内。
  const restoreSavedPosition = (video: HTMLVideoElement) => {
    if (!savedProgress.current) return;
    video.currentTime = Math.max(0, Math.min(savedProgress.current.position, video.duration));
  };

  useEffect(() => {
    const video = videoRef.current;
    // 开发环境重复执行 Effect 时恢复已清理的视频源，使播放器可继续加载。
    if (video && video.getAttribute("src") !== src) video.setAttribute("src", src);
    // 页面隐藏或卸载前保存当前播放进度。
    const flush = () => persist();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      // 切换内容或卸载前保存位置并释放媒体源，避免旧视频继续播放。
      persist(video);
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
    };
  }, [contentKey, src]);

  // 用户选择从头播放时清除旧进度并将播放位置归零。
  const chooseStart = () => {
    canPersist.current = true;
    clearProgress(contentKey);
    savedProgress.current = null;
    setResumeChoice("start");
    if (videoRef.current) videoRef.current.currentTime = 0;
  };
  // 用户选择继续播放时允许写入进度，并在元数据就绪后恢复位置。
  const chooseContinue = () => {
    canPersist.current = true;
    setResumeChoice("continue");
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) restoreSavedPosition(video);
  };

  return <div className="video-player">
    <video
      ref={videoRef}
      data-testid="native-video"
      aria-label={title}
      controls={resumeChoice !== "pending"}
      tabIndex={resumeChoice === "pending" ? -1 : undefined}
      preload="metadata"
      src={src}
      onLoadedMetadata={(event) => {
        // 元数据给出真实时长后才恢复位置；用户未选择继续时保留默认播放起点。
        if (resumeChoice !== "continue" || !savedProgress.current) return;
        restoreSavedPosition(event.currentTarget);
      }}
      onTimeUpdate={() => {
        // 播放过程中最多每五秒写一次本地进度，暂停和离页仍由各自事件立即保存。
        if (Date.now() - lastSavedAt.current >= 5_000) persist();
      }}
      onPause={() => persist()}
      onEnded={() => clearProgress(contentKey)}
      onCanPlay={() => setPlaybackState("ready")}
      onError={() => setPlaybackState("error")}
    />
    {playbackState === "error"
      ? <p className="playback-message playback-error" role="alert">浏览器无法播放此视频格式。请联系管理员上传浏览器可直接播放的视频。</p>
      : <p className="playback-message" role="status">{playbackState === "ready" ? "视频已可以播放" : "正在检查浏览器是否可以播放此视频"}</p>}
    {resumeChoice === "pending" && <section className="resume-prompt" role="dialog" aria-label="选择播放位置">
      <p>检测到本浏览器保存的观看进度。</p>
      <div className="player-actions">
        <button type="button" className="pill is-active" autoFocus onClick={chooseContinue}>继续播放</button>
        <button type="button" className="pill" onClick={chooseStart}>从头播放</button>
      </div>
    </section>}
  </div>;
}
