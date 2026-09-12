import { useEffect, useRef, useState } from "react";
import type { MediaSummary } from "@movie-harbor/api-client";

export function PosterPicker({ current, file, onSelect, readOnly, disabled }: {
  current: MediaSummary | null; file: File | null; onSelect: (file: File) => void; readOnly: boolean; disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    if (!file || readOnly) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, readOnly]);
  const source = readOnly ? current?.url : preview ?? current?.url;
  useEffect(() => setPosterFailed(false), [source]);
  const picture = source && !posterFailed
    ? <img src={source} alt="当前海报预览" onError={() => setPosterFailed(true)} />
    : <div className="poster-blank" aria-hidden="true" />;
  return <div className="movie-poster">
    {readOnly ? <div className="movie-poster-frame">{picture}</div> : <>
      <button className="movie-poster-frame" type="button" aria-label="选择或替换海报" disabled={disabled} onClick={() => input.current?.click()}>{picture}{source && !posterFailed ? <span className="movie-poster-change">点击替换海报</span> : null}</button>
      <input ref={input} aria-label="海报文件" type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={disabled} onChange={(event) => {
        const selected = event.currentTarget.files?.[0];
        if (selected) onSelect(selected);
        event.currentTarget.value = "";
      }} />
      <p>建议比例 2:3，支持 JPG、PNG、WebP</p>
      {file && <p>待上传：{file.name}</p>}
    </>}
    {current && <p><a href={current.url} target="_blank" rel="noreferrer">已保存海报：{current.original_name}</a></p>}
  </div>;
}
