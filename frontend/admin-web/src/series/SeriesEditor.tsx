import { useEffect, useRef, useState } from "react";
import { ApiError, apiErrorCode, createSeries, createSeason, createEpisode, deleteSeries, deleteSeason, deleteEpisode, getEpisodeDeleteImpact, getSeasonDeleteImpact, getSeries, getSeriesDeleteImpact, listGenres, transitionSeries, transitionEpisode, updateSeries, updateSeason, updateEpisode, uploadMedia, type ChildDeleteImpactResponse, type DeleteImpactResponse, type EpisodeEnvelope, type EpisodeResponse, type GenreResponse, type SeasonResponse, type SeriesResponse } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { PosterPicker } from "../movies/PosterPicker";
import { SeasonCard } from "./SeasonCard";
import { SeriesPublishErrors } from "./SeriesPublishErrors";
import { canAct, canChangeSeason, knownStatus, permits, statusNames } from "./permissions";
import type { EpisodeFields } from "./EpisodeRow";

type Fields = { name: string; year: string; synopsis: string; genreIds: string[] };
type Deletion = { series: SeriesResponse; season?: SeasonResponse; episode?: EpisodeResponse; impact: DeleteImpactResponse | ChildDeleteImpactResponse };
const empty: Fields = { name: "", year: "", synopsis: "", genreIds: [] };
function fieldsOf(series: SeriesResponse): Fields { return { name: series.name, year: series.year?.toString() ?? "", synopsis: series.synopsis, genreIds: series.genres.map((g) => g.id) }; }
function deletionAllowed(target: Pick<Deletion, "series" | "season" | "episode">) {
  if (!knownStatus(target.series.status)) return false;
  if (target.episode) return canAct(target.episode, "delete");
  if (target.season) return canChangeSeason(target.series, target.season, "delete");
  return canAct(target.series, "delete") && target.series.seasons.every((s) => s.episodes.every((e) => knownStatus(e.status)));
}

export function SeriesEditor({ seriesId, onBack, onExpired, onCreated = () => {}, onDeleteSuccess = () => {}, initialDelete = false, resumeCreation = false }: { seriesId: string | null; onBack: () => void; onExpired: () => void; onCreated?: (id: string) => void; onDeleteSuccess?: () => void; initialDelete?: boolean; resumeCreation?: boolean }) {
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
  const [genres, setGenres] = useState<GenreResponse[]>([]);
  const [poster, setPoster] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [newSeasons, setNewSeasons] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Deletion | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const operation = useRef(false);
  const mounted = useMounted();
  const current = useRef<SeriesResponse | null>(null);
  function accept(value: SeriesResponse, resetFields = false) {
    current.current = value; setSeries(value);
    if (resetFields) setFields(fieldsOf(value));
  }
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError(""); setInvalid([]); setNotice(""); setPoster(null); setDeleting(null); setNewSeasons([]);
    const watch = <T,>(request: Promise<T>) => request.catch((cause: unknown) => {
      if (!ignore && cause instanceof ApiError && cause.status === 401) onExpired();
      throw cause;
    });
    const id = current.current?.id ?? seriesId;
    void Promise.all([id ? watch(getSeries(id)) : null, watch(listGenres())]).then(async ([value, choices]) => {
      if (ignore) return;
      setGenres(choices); setConflict(false);
      if (value) {
        accept(value, true);
        if (resumeCreation) setNewSeasons(value.seasons.filter((season) => season.episodes.length === 0).map((season) => season.id));
        if (initialDelete && revision === 0 && deletionAllowed({ series: value })) {
          const impact = await watch(getSeriesDeleteImpact(value.id));
          if (!ignore) { setDeleting({ series: value, impact }); setConfirmation(""); }
        }
      }
    }).catch((cause: unknown) => { if (!ignore && !(cause instanceof ApiError && cause.status === 401)) { setError("剧集详情加载失败，请重新加载。"); setConflict(true); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
    // App keys the editor by identity; revision explicitly discards pending local drafts.
  }, [revision, onExpired]);

  async function fail(cause: unknown) {
    if (!mounted.current) return;
    if (cause instanceof ApiError && cause.status === 401) onExpired();
    else if (cause instanceof ApiError && cause.status === 403) {
      const recovery = await recoverForbiddenWrite();
      if (!mounted.current) return;
      if (recovery.expired) onExpired(); else setError(recovery.message);
    } else if (cause instanceof ApiError && apiErrorCode(cause) === "media_delete_failed") {
      setError("删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。");
    } else if (cause instanceof ApiError && apiErrorCode(cause) === "media_replace_failed") {
      setError("替换失败，原媒体文件已保留，请检查媒体目录权限后重试。");
    } else if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setDeleting(null); setError("内容已发生变化，请刷新后重试。"); }
    else if (cause instanceof ApiError && cause.status === 422 && cause.details && typeof cause.details === "object" && "fields" in cause.details && Array.isArray(cause.details.fields)) {
      setInvalid(cause.details.fields.filter((f): f is string => typeof f === "string"));
    } else setError(cause instanceof ApiError ? `操作失败：${cause.message}` : "操作失败，请检查网络后重试。");
  }
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (operation.current || loading || conflict || !mounted.current) return false;
    operation.current = true; setBusy(true); setError(""); setInvalid([]); setNotice("");
    try { await action(); return mounted.current; }
    catch (cause) { await fail(cause); return false; }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function refresh(expectedVersion?: number, resetFields = false): Promise<SeriesResponse | null> {
    if (!mounted.current || !current.current) return null;
    setConflict(true);
    const fresh = await getSeries(current.current.id);
    if (!mounted.current) return null;
    if (expectedVersion !== undefined && fresh.version !== expectedVersion) throw new ApiError(409, "Conflict", "Content changed after upload", undefined);
    accept(fresh, resetFields); setConflict(false); return fresh;
  }
  function acceptEpisode(result: EpisodeEnvelope) {
    const parent = current.current;
    if (!mounted.current || !parent) return;
    accept({ ...parent, version: result.series_version, seasons: parent.seasons.map((s) => ({ ...s, episodes: s.episodes.map((e) => e.id === result.episode.id ? result.episode : e) })) });
  }
  async function saveBasic(): Promise<SeriesResponse | null> {
    const parent = current.current;
    if (!parent || !canAct(parent, "edit")) return null;
    let saved = await updateSeries(parent.id, { version: parent.version, name: fields.name, synopsis: fields.synopsis, year: fields.year === "" ? null : Number(fields.year), genre_ids: fields.genreIds });
    if (!mounted.current) return null;
    accept(saved, true);
    if (poster) {
      const uploaded = await uploadMedia({ kind: "series", id: saved.id, slot: "poster" }, poster, saved.version);
      if (!mounted.current) return null;
      const fresh = await refresh(uploaded.version, true);
      if (!fresh) return null;
      saved = fresh; setPoster(null);
    }
    return saved;
  }
  async function saveEpisode(episode: EpisodeResponse, values: EpisodeFields, file: File | null, publish: boolean, onUploaded: () => void) {
    return run(async () => {
      const parent = current.current;
      if (!parent || !knownStatus(parent.status) || !canAct(episode, "edit")) return;
      let saved = await updateEpisode(parent.id, episode.season_id, episode.id, { ...values, version: episode.version });
      if (!mounted.current) return;
      acceptEpisode(saved);
      if (file) {
        const uploaded = await uploadMedia({ kind: "episodes", id: episode.id, slot: "video" }, file, saved.episode.version);
        if (!mounted.current) return;
        // Both episode and parent versions must agree with the atomic upload result.
        setConflict(true);
        if (uploaded.series_version === undefined) throw new Error("Upload response omitted the series version");
        const fresh = await refresh(uploaded.series_version);
        if (!fresh) return;
        const updated = fresh.seasons.flatMap((s) => s.episodes).find((e) => e.id === episode.id);
        if (!updated || updated.version !== uploaded.version) throw new ApiError(409, "Conflict", "Episode changed after upload", undefined);
        saved = { episode: updated, series_version: fresh.version };
        onUploaded();
      }
      if (publish && mounted.current && canAct(saved.episode, "publish")) {
        await transitionEpisode(parent.id, episode.season_id, episode.id, "publish", saved.episode.version); await refresh();
      } else if (mounted.current) setNotice("单集草稿已保存。");
    });
  }
  async function prepareDelete(seasonId?: string, episodeId?: string, loadedSeries?: SeriesResponse) {
    await run(async () => {
      const fresh = loadedSeries ?? await refresh(); if (!fresh) return;
      if (!seasonId && !episodeId) {
        const impact = await getSeriesDeleteImpact(fresh.id);
        if (!mounted.current) return;
        setDeleting({ series: fresh, impact }); setConfirmation(""); return;
      }
      const season = seasonId ? fresh.seasons.find((s) => s.id === seasonId) : undefined;
      const episode = episodeId ? season?.episodes.find((e) => e.id === episodeId) : undefined;
      if ((seasonId && !season) || (episodeId && !episode)) throw new ApiError(409, "Conflict", "Content changed", undefined);
      const candidate = { series: fresh, season, episode };
      if (!deletionAllowed(candidate)) { setError("服务器最新状态不允许删除，请先归档已发布内容。"); return; }
      const impact = episode && season
        ? await getEpisodeDeleteImpact(fresh.id, season.id, episode.id)
        : await getSeasonDeleteImpact(fresh.id, season!.id);
      const target = { ...candidate, impact };
      if (!deletionAllowed(target)) { setError("服务器最新状态不允许删除，请先归档已发布内容。"); return; }
      setDeleting(target); setConfirmation("");
    });
  }
  const locked = busy || loading || conflict;
  const readOnly = !series || !canAct(series, "edit");
  const choices = [...genres, ...(series?.genres.filter((g) => !genres.some((choice) => choice.id === g.id)).map((g) => ({ ...g, sort_order: 0 })) ?? [])];
  const deleteName = deleting ? "display_name" in deleting.impact ? deleting.impact.display_name : deleting.impact.name : "";
  return <section>
    <div inert={!!deleting}>
      <div className="admin-title-row"><div><p className="eyebrow">SERIES · {series ? statusNames[series.status] ?? "未知状态" : "新建"}</p><h1>{series ? series.status === "draft" ? "编辑剧集草稿" : "查看剧集" : "新建剧集草稿"}</h1></div><Button disabled={busy} onClick={onBack}>返回列表</Button></div>
      {!deleting && error && <div className="request-error"><p role="alert">{error}</p><Button disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}>重新加载</Button></div>}
      {!deleting && invalid.length > 0 && <SeriesPublishErrors fields={invalid} />}
      {notice && <p role="status">{notice}</p>}
      {loading ? <p role="status">正在加载剧集…</p> : !series ? <form className="movie-form" onSubmit={(event) => {
        event.preventDefault(); if (!fields.name.trim()) return;
        void run(async () => {
          const created = await createSeries(fields.name); if (!mounted.current) return;
          accept(created, true); onCreated(created.id);
          const saved = await createSeason(created.id, 1, created.version); if (!mounted.current) return;
          setNewSeasons(saved.seasons.map((s) => s.id)); accept(saved);
        });
      }}><Field label="剧集名称" className="movie-field-medium"><input required disabled={locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field><Button type="submit" disabled={locked} variant="primary">创建草稿</Button></form> : <>
        <section className="series-section" aria-labelledby="series-basic-title"><h2 id="series-basic-title">基本信息</h2>
          <div className="movie-editor-card"><PosterPicker current={series.poster} file={poster} onSelect={setPoster} readOnly={readOnly} disabled={locked} />
            <form className="movie-form" onSubmit={(event) => {
              event.preventDefault(); if (!fields.name.trim()) return;
              const publish = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "publish";
              void run(async () => { const saved = await saveBasic(); if (!saved || !mounted.current) return; if (publish && canAct(saved, "publish")) { await transitionSeries(saved.id, "publish", saved.version); await refresh(undefined, true); } else setNotice("剧集草稿已保存。"); });
            }}>
              <Field label="剧集名称" className="movie-field-medium"><input required disabled={readOnly || locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field>
              <Field label="首播年份" className="movie-field-short"><input type="number" min="1" max="9999" disabled={readOnly || locked} value={fields.year} onChange={(e) => setFields({ ...fields, year: e.target.value })} /></Field>
              <Field label="简介" className="movie-field-wide"><textarea rows={4} disabled={readOnly || locked} value={fields.synopsis} onChange={(e) => setFields({ ...fields, synopsis: e.target.value })} /></Field>
              <Field label="题材" className="movie-field-medium"><select multiple size={3} disabled={readOnly || locked} value={fields.genreIds} onChange={(e) => {
                const retained = fields.genreIds.filter((id) => choices.some((g) => g.id === id && !g.enabled));
                setFields({ ...fields, genreIds: [...new Set([...retained, ...Array.from(e.target.selectedOptions).map((o) => o.value)])] });
              }}>{choices.filter((g) => g.enabled || fields.genreIds.includes(g.id)).map((g) => <option key={g.id} value={g.id} disabled={!g.enabled}>{g.name}{g.enabled ? "" : "（已停用）"}</option>)}</select></Field>
              <div className="movie-form-actions">
                {canAct(series, "edit") && <Button type="submit" disabled={locked}>保存剧集草稿</Button>}
                {canAct(series, "publish") && series.status === "draft" && <Button type="submit" value="publish" disabled={locked} variant="primary">发布剧集</Button>}
                {(["publish", "archive", "draft"] as const).filter((action) => canAct(series, action) && !(action === "publish" && series.status === "draft")).map((action) => <Button key={action} disabled={locked} onClick={() => { void run(async () => { await transitionSeries(series.id, action, series.version); await refresh(undefined, true); }); }}>{action === "archive" ? "归档剧集" : action === "draft" ? "剧集转为草稿" : "原样发布剧集"}</Button>)}
                {canAct(series, "delete") && <Button variant="danger" disabled={locked} onClick={() => { void prepareDelete(); }}>永久删除剧集</Button>}
              </div>
            </form>
          </div>
        </section>
        <section className="series-section" aria-labelledby="series-structure-title"><h2 id="series-structure-title">季与单集</h2><p>季只填写序号；每一集必须输入名称，独立保存草稿和上传视频。</p>
          {series.seasons.map((season) => <SeasonCard key={`${revision}:${season.id}`} series={series} season={season} disabled={locked} initialEpisode={newSeasons.includes(season.id)}
            actions={{ save: saveEpisode, transition: (episode, action) => { if (canAct(episode, action)) void run(async () => { await transitionEpisode(series.id, season.id, episode.id, action, episode.version); await refresh(); }); }, remove: (episode) => { void prepareDelete(season.id, episode.id); } }}
            create={(number, name) => run(async () => { if (!knownStatus(series.status) || !permits(series, "add_episode") || !permits(season, "add_episode")) return; const saved = await createEpisode(series.id, season.id, { version: series.version, number, name }); if (mounted.current) { accept(saved); setNotice("单集草稿已保存。"); } })}
            update={(number) => { if (canChangeSeason(series, season, "edit")) void run(async () => { const saved = await updateSeason(series.id, season.id, number, series.version); if (mounted.current) accept(saved); }); }}
            remove={() => { void prepareDelete(season.id); }} />)}
          <Button disabled={locked || !knownStatus(series.status) || !permits(series, "add_season")} onClick={() => { void run(async () => {
            const saved = await createSeason(series.id, Math.max(0, ...series.seasons.map((s) => s.number)) + 1, series.version);
            if (mounted.current) { setNewSeasons((ids) => [...ids, ...saved.seasons.filter((s) => !series.seasons.some((old) => old.id === s.id)).map((s) => s.id)]); accept(saved); }
          }); }}>添加一季</Button>
        </section>
      </>}
    </div>
    <Dialog open={!!deleting} title={deleting?.episode ? "永久删除单集" : deleting?.season ? "永久删除本季" : "永久删除剧集"} onClose={() => { if (!busy) setDeleting(null); }}>
      {deleting && <><p>将永久删除“{deleteName}”，不可恢复，没有回收站。</p><p>根据服务器最新删除影响，影响范围：</p>
        <ul><li>季：{deleting.impact.season_count}</li><li>单集：{deleting.impact.episode_count}</li><li>媒体文件：{deleting.impact.media_count}</li></ul>
        {deleting.season && !deleting.episode && <p>请输入服务器确认名称：{deleteName}</p>}
        {error && <p role="alert">{error}</p>}
        <Field label="输入完整内容名称"><input disabled={busy} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
        <div className="dialog-actions"><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={locked || confirmation !== deleteName || !deletionAllowed(deleting)} onClick={() => { void run(async () => {
          const target = deleting;
          if (target.episode && target.season) await deleteEpisode(target.series.id, target.season.id, target.episode.id, target.impact.version);
          else if (target.season) await deleteSeason(target.series.id, target.season.id, target.impact.version);
          else { await deleteSeries(target.series.id, target.impact.version); if (mounted.current) { onDeleteSuccess(); onBack(); } return; }
          if (mounted.current) { setDeleting(null); setNotice("内容及其媒体文件已删除"); }
          await refresh();
        }); }}>确认永久删除</Button></div>
      </>}
    </Dialog>
  </section>;
}
