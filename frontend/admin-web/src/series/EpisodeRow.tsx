import { useEffect, useState } from "react";
import type { ApiUploadProgress, EpisodeResponse } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { VideoPicker } from "../movies/VideoPicker";
import { canAct, statusNames } from "./permissions";

// 定义单集可编辑字段，在单集表单与保存回调间传递。
export type EpisodeFields = { number: number; name: string; duration_seconds: number | null };
// 定义单集保存、转换和删除回调，在季卡片与单集行间传递。
export type EpisodeActions = {
  save: (
    episode: EpisodeResponse,
    fields: EpisodeFields,
    file: File | null,
    publish: boolean,
    onUploaded: () => void,
    onProgress: (progress: ApiUploadProgress) => void,
  ) => Promise<boolean>;
  transition: (episode: EpisodeResponse, action: "publish" | "archive" | "draft") => void;
  remove: (episode: EpisodeResponse) => void;
};
// 展示单集表单、上传进度和生命周期操作，在展开季时使用。
export function EpisodeRow({ episode, disabled, actions }: { episode: EpisodeResponse; disabled: boolean; actions: EpisodeActions }) {
  const [name, setName] = useState(episode.name);
  const [number, setNumber] = useState(String(episode.number));
  const [minutes, setMinutes] = useState(episode.duration_seconds === null ? "" : String(episode.duration_seconds / 60));
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<ApiUploadProgress | null>(null);
  const mounted = useMounted();
  // 单集身份、版本或状态变化时同步服务端字段；退出草稿状态后清除待上传文件。
  useEffect(() => {
    setName(episode.name); setNumber(String(episode.number));
    setMinutes(episode.duration_seconds === null ? "" : String(episode.duration_seconds / 60));
    if (episode.status !== "draft") { setFile(null); setUploadProgress(null); }
    // 完整层级刷新但单集版本未变时不重置字段，保留其他单集尚未保存的输入。
  }, [episode.id, episode.version, episode.status]);
  const readOnly = !canAct(episode, "edit");
  return <form className="series-episode" aria-label={`第 ${episode.number} 集 · ${episode.name}`} onSubmit={(event) => {
    event.preventDefault(); if (!name.trim() || readOnly) return;
    const publish = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "publish";
    // 保存当前单集并单独跟踪其上传进度；成功关联后清除文件，结束时清除进度。
    void actions.save(
      episode,
      { number: Number(number), name, duration_seconds: minutes === "" ? null : Math.round(Number(minutes) * 60) },
      file,
      publish,
      () => { if (mounted.current) setFile(null); },
      (progress) => { if (mounted.current) setUploadProgress(progress); },
    ).finally(() => { if (mounted.current) setUploadProgress(null); });
  }}>
    <p>第 {episode.number} 集 · {episode.name} <span>{statusNames[episode.status] ?? "未知状态"}</span></p>
    <div className="movie-inline-fields">
      <Field label="集序号" className="movie-field-short"><input type="number" min="1" required disabled={disabled || readOnly} value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
      <Field label="单集名称" className="movie-field-medium"><input required disabled={disabled || readOnly} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="时长（分钟）" className="movie-field-short"><input type="number" min="0" step="any" disabled={disabled || readOnly} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
    </div>
    <VideoPicker current={episode.video} file={file} onSelect={setFile} readOnly={readOnly} disabled={disabled} progress={uploadProgress} />
    <div className="movie-form-actions">
      {canAct(episode, "edit") && <Button type="submit" disabled={disabled}>保存单集草稿</Button>}
      {canAct(episode, "publish") && (episode.status === "draft" ? <Button type="submit" value="publish" disabled={disabled}>发布单集</Button> : <Button disabled={disabled} onClick={() => actions.transition(episode, "publish")}>原样发布单集</Button>)}
      {canAct(episode, "archive") && <Button disabled={disabled} onClick={() => actions.transition(episode, "archive")}>归档单集</Button>}
      {canAct(episode, "draft") && <Button disabled={disabled} onClick={() => actions.transition(episode, "draft")}>单集转为草稿</Button>}
      {canAct(episode, "delete") && <Button variant="danger" disabled={disabled} onClick={() => actions.remove(episode)}>删除单集</Button>}
    </div>
  </form>;
}
