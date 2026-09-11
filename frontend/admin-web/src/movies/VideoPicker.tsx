import { Field } from "@movie-harbor/ui";
import type { MediaSummary } from "@movie-harbor/api-client";

export function VideoPicker({ current, file, onSelect, readOnly, disabled }: {
  current: MediaSummary | null; file: File | null; onSelect: (file: File) => void; readOnly: boolean; disabled: boolean;
}) {
  return <div className="movie-field-wide">
    {current ? <p><a href={current.url} target="_blank" rel="noreferrer">已保存视频：{current.original_name}</a></p> : <p>尚未上传视频</p>}
    {!readOnly && <><Field label="视频文件" helpText="仅支持浏览器可直接播放的视频，不自动转码。"><input type="file" accept="video/mp4,video/webm" disabled={disabled} onChange={(event) => {
      const selected = event.currentTarget.files?.[0];
      if (selected) onSelect(selected);
      event.currentTarget.value = "";
    }} /></Field>{file && <p>待上传：{file.name}（{file.size} 字节）</p>}</>}
  </div>;
}
