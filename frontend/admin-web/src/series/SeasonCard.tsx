import { useEffect, useRef, useState } from "react";
import type { SeasonResponse, SeriesResponse } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";
import { EpisodeRow, type EpisodeActions } from "./EpisodeRow";
import { canChangeSeason, knownStatus, permits } from "./permissions";

function NewEpisode({ number, disabled, create, remove, changeNumber }: { number: number; disabled: boolean; create: (number: number, name: string) => Promise<boolean>; remove: () => void; changeNumber: (number: number) => void }) {
  const [name, setName] = useState(""); const [value, setValue] = useState(String(number));
  return <form className="series-episode" aria-label="新单集草稿" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(Number(value), name).then((saved) => { if (saved) remove(); }); }}>
    <div className="movie-inline-fields"><Field label="集序号" className="movie-field-short"><input type="number" min="1" required disabled={disabled} value={value} onChange={(e) => { setValue(e.target.value); changeNumber(Number(e.target.value)); }} /></Field><Field label="单集名称" className="movie-field-medium"><input required disabled={disabled} value={name} placeholder="请输入名称" onChange={(e) => setName(e.target.value)} /></Field></div>
    <p>保存单集草稿后可填写时长并上传视频。</p>
    <div className="movie-form-actions"><Button type="submit" disabled={disabled}>保存单集草稿</Button><Button variant="danger" disabled={disabled} onClick={remove}>移除未保存单集</Button></div>
  </form>;
}
export function SeasonCard({ series, season, disabled, initialEpisode, actions, create, update, remove }: {
  series: SeriesResponse; season: SeasonResponse; disabled: boolean; initialEpisode: boolean; actions: EpisodeActions;
  create: (number: number, name: string) => Promise<boolean>; update: (number: number) => void; remove: () => void;
}) {
  const [number, setNumber] = useState(String(season.number));
  const [drafts, setDrafts] = useState<{ key: number; number: number }[]>(initialEpisode ? [{ key: 0, number: 1 }] : []);
  const next = useRef(1);
  useEffect(() => setNumber(String(season.number)), [season.number]);
  const canAdd = knownStatus(series.status) && permits(series, "add_episode") && permits(season, "add_episode");
  return <article className="series-season" aria-label={`第 ${season.number} 季`}>
    <div className="series-season-header"><h3>第 {season.number} 季</h3><form className="movie-inline-fields" onSubmit={(e) => { e.preventDefault(); update(Number(number)); }}>
      <Field label="季序号" className="movie-field-short"><input type="number" min="1" required value={number} disabled={disabled || !canChangeSeason(series, season, "edit")} onChange={(e) => setNumber(e.target.value)} /></Field>
      <Button type="submit" disabled={disabled || !canChangeSeason(series, season, "edit")}>保存季序号</Button>
    </form><Button variant="danger" disabled={disabled || !canChangeSeason(series, season, "delete")} onClick={remove}>删除本季</Button></div>
    {!canChangeSeason(series, season, "edit") && <p>存在已发布单集或权限受限，季序号与删除已锁定。</p>}
    {season.episodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} disabled={disabled || !knownStatus(series.status)} actions={actions} />)}
    {drafts.map((draft) => <NewEpisode key={draft.key} number={draft.number} disabled={disabled || !canAdd} create={create} changeNumber={(number) => setDrafts((values) => values.map((value) => value.key === draft.key ? { ...value, number } : value))} remove={() => setDrafts((values) => values.filter((v) => v.key !== draft.key))} />)}
    <Button disabled={disabled || !canAdd} onClick={() => setDrafts((values) => [...values, { key: next.current++, number: Math.max(0, ...season.episodes.map((e) => e.number), ...values.map((e) => e.number)) + 1 }])}>添加一集</Button>
  </article>;
}
