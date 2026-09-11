import { useEffect, useRef, useState } from "react";
import { clearProgress, getProgress, saveProgress, type PlaybackContentKey } from "./progressStore";

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

  const persist = () => {
    if (!canPersist.current) return;
    const video = videoRef.current;
    if (!video) return;
    saveProgress(contentKey, video.currentTime, video.duration);
    lastSavedAt.current = Date.now();
  };

  const restoreSavedPosition = (video: HTMLVideoElement) => {
    if (!savedProgress.current) return;
    video.currentTime = Math.max(0, Math.min(savedProgress.current.position, video.duration));
  };

  useEffect(() => {
    const flush = () => persist();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      persist();
    };
  }, [contentKey]);

  const chooseStart = () => {
    canPersist.current = true;
    clearProgress(contentKey);
    savedProgress.current = null;
    setResumeChoice("start");
    if (videoRef.current) videoRef.current.currentTime = 0;
  };
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
        if (resumeChoice !== "continue" || !savedProgress.current) return;
        restoreSavedPosition(event.currentTarget);
      }}
      onTimeUpdate={() => {
        if (Date.now() - lastSavedAt.current >= 5_000) persist();
      }}
      onPause={persist}
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
