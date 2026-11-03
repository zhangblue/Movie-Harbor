import { useEffect, useRef, useState } from "react";
import { ApiError, normalizeError, type CaughtValue, apiErrorCode, createSeries, createSeason, createEpisode, deleteSeries, deleteSeason, deleteEpisode, getEpisodeDeleteImpact, getSeasonDeleteImpact, getSeries, getSeriesDeleteImpact, listGenres, transitionSeries, transitionEpisode, updateSeries, updateSeason, updateEpisode, uploadMedia, type ApiUploadProgress, type ChildDeleteImpactResponse, type DeleteImpactResponse, type EpisodeEnvelope, type EpisodeResponse, type GenreResponse, type SeasonResponse, type SeriesResponse } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { classifyEditorWriteError, mergeGenreChoices } from "../content/editorSupport";
import { PrivacySelector } from "../content/PrivacySelector";
import { PosterPicker } from "../movies/PosterPicker";
import { SeasonCard } from "./SeasonCard";
import { SeriesPublishErrors } from "./SeriesPublishErrors";
import { canAct, canChangeSeason, knownStatus, permits, statusNames } from "./permissions";
import type { EpisodeFields } from "./EpisodeRow";

// 保存编辑表单字段，在详情与表单之间转换时使用。
type Fields = { name: string; year: string; synopsis: string; genreIds: string[] };
// 保存删除目标与服务端影响范围，在剧集删除确认时使用。
type Deletion = { series: SeriesResponse; season?: SeasonResponse; episode?: EpisodeResponse; impact: DeleteImpactResponse | ChildDeleteImpactResponse };
const empty: Fields = { name: "", year: "", synopsis: "", genreIds: [] };
// 将服务端详情转换为编辑表单字段，在加载或刷新详情时使用。
function fieldsOf(series: SeriesResponse): Fields { return { name: series.name, year: series.year?.toString() ?? "", synopsis: series.synopsis, genreIds: series.genres.map((g) => g.id) }; }
// 依据剧集、季和单集状态判断是否允许删除，在打开和确认删除前调用。
function deletionAllowed(target: Pick<Deletion, "series" | "season" | "episode">) {
  if (!knownStatus(target.series.status)) return false;
  if (target.episode) return canAct(target.episode, "delete");
  if (target.season) return canChangeSeason(target.series, target.season, "delete");
  return canAct(target.series, "delete") && target.series.seasons.every((s) => s.episodes.every((e) => knownStatus(e.status)));
}

// 管理剧集、季和单集编辑及生命周期，在打开剧集详情时使用。
export function SeriesEditor({ seriesId, onBack, onExpired, onCreated = () => {}, onDeleteSuccess = () => {}, onDeleteFinalization = () => {}, initialDelete = false, resumeCreation = false }: { seriesId: string | null; onBack: () => void; onExpired: () => void; onCreated?: (id: string) => void; onDeleteSuccess?: () => void; onDeleteFinalization?: () => void; initialDelete?: boolean; resumeCreation?: boolean }) {
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
  const [isPrivate, setIsPrivate] = useState(false);
  const [genres, setGenres] = useState<GenreResponse[]>([]);
  const [poster, setPoster] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [revision, setRevision] = useState(0);
  const [newSeasons, setNewSeasons] = useState<string[]>([]);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(() => new Set());
  const viewOnly = !!series && series.status !== "draft";
  // 进入只读查看模式时收起季，避免保留草稿编辑时的展开状态。
  useEffect(() => {
    if (viewOnly) setExpandedSeasons(new Set());
  }, [viewOnly]);
  const [deleting, setDeleting] = useState<Deletion | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const operation = useRef(false);
  const mounted = useMounted();
  const current = useRef<SeriesResponse | null>(null);
  // 接收服务端最新详情并同步界面，在加载或成功写入后调用。
  function accept(value: SeriesResponse, resetFields = false) {
    current.current = value; setSeries(value);
    setExpandedSeasons((ids) => new Set([...ids].filter((id) => value.seasons.some((season) => season.id === id))));
    if (resetFields) setFields(fieldsOf(value));
  }
  // 打开或刷新剧集时读取完整层级和题材；丢弃过期响应并按需恢复未完成创建。
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError(""); setInvalid([]); setNotice(""); setWarning(""); setPoster(null); setDeleting(null); setNewSeasons([]); setExpandedSeasons(new Set());
    // 检查异步请求的会话失效状态，在并行加载详情时调用。
    const watch = <T,>(request: Promise<T>) => request.catch((cause: CaughtValue) => {
      const error = normalizeError(cause);
      if (!ignore && error instanceof ApiError && error.status === 401) onExpired();
      throw error;
    });
    const id = current.current?.id ?? seriesId;
    void Promise.all([id ? watch(getSeries(id)) : null, watch(listGenres())]).then(async ([value, choices]) => {
      // 接收完整层级后恢复新建流程或读取删除影响，后续请求失败时统一锁定等待刷新。
      if (ignore) return;
      setGenres(choices); setConflict(false);
      if (value) {
        accept(value, true);
        if (resumeCreation) {
          const seasonIds = value.seasons.filter((season) => season.episodes.length === 0).map((season) => season.id);
          setNewSeasons(seasonIds); setExpandedSeasons(new Set(seasonIds));
        }
        if (initialDelete && revision === 0 && deletionAllowed({ series: value })) {
          const impact = await watch(getSeriesDeleteImpact(value.id));
          if (!ignore) { setDeleting({ series: value, impact }); setConfirmation(""); }
        }
      }
    }).catch((cause: CaughtValue) => { const error = normalizeError(cause); if (!ignore && !(error instanceof ApiError && error.status === 401)) { setError("剧集详情加载失败，请重新加载。"); setConflict(true); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
    // App 按身份区分编辑器；revision 表示主动刷新并丢弃待处理的本地草稿。
  }, [revision, onExpired]);

  // 按会话、冲突和校验错误更新反馈，在写入失败时调用。
  async function fail(error: Error) {
    if (!mounted.current) return;
    if (error instanceof ApiError && error.status === 401) onExpired();
    else if (error instanceof ApiError && error.status === 403) {
      // 恢复会话和令牌后由用户决定是否重试，避免隐式重复层级写入。
      const recovery = await recoverForbiddenWrite();
      if (!mounted.current) return;
      if (recovery.expired) onExpired(); else setError(recovery.message);
    } else {
      const result = classifyEditorWriteError(error);
      if (result.kind === "conflict") { setConflict(true); setDeleting(null); setError("内容已发生变化，请刷新后重试。"); }
      else if (result.kind === "validation") setInvalid(result.fields);
      else setError(result.message);
    }
  }
  // 串行执行写入并统一处理忙碌状态和错误，在用户发起操作时调用。
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (operation.current || loading || conflict || !mounted.current) return false;
    operation.current = true; setBusy(true); setError(""); setInvalid([]); setNotice(""); setWarning("");
    try { await action(); return mounted.current; }
    catch (cause) { const error = normalizeError(cause as CaughtValue); await fail(error); return false; }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  // 重新读取剧集层级并核对预期版本，写入或上传后调用以避免使用过期数据。
  async function refresh(expectedVersion?: number, resetFields = false): Promise<SeriesResponse | null> {
    if (!mounted.current || !current.current) return null;
    setConflict(true);
    const fresh = await getSeries(current.current.id);
    if (!mounted.current) return null;
    // 上传后若父级版本已变化，保持锁定并阻止后续写入或发布。
    if (expectedVersion !== undefined && fresh.version !== expectedVersion) throw new ApiError(409, "Conflict", "Content changed after upload", undefined);
    accept(fresh, resetFields); setConflict(false); return fresh;
  }
  // 合并服务端单集及父级版本，在单集更新成功后调用。
  function acceptEpisode(result: EpisodeEnvelope) {
    const parent = current.current;
    if (!mounted.current || !parent) return;
    accept({ ...parent, version: result.series_version, seasons: parent.seasons.map((s) => ({ ...s, episodes: s.episodes.map((e) => e.id === result.episode.id ? result.episode : e) })) });
  }
  // 保存剧集字段和待替换海报，在保存或发布剧集前调用。
  async function saveBasic(): Promise<SeriesResponse | null> {
    const parent = current.current;
    if (!parent || !canAct(parent, "edit")) return null;
    // 先保存剧集字段，再用返回版本替换海报，确保后续发布引用最新状态。
    let saved = await updateSeries(parent.id, { version: parent.version, name: fields.name, synopsis: fields.synopsis, year: fields.year === "" ? null : Number(fields.year), genre_ids: fields.genreIds });
    if (!mounted.current) return null;
    accept(saved, true);
    if (poster) {
      let uploaded;
      try {
        uploaded = await uploadMedia({ kind: "series", id: saved.id, slot: "poster" }, poster, saved.version);
      } catch (cause) {
        const error = normalizeError(cause as CaughtValue);
        if (!(error instanceof ApiError) || apiErrorCode(error) !== "media_replace_finalization_failed") throw error;
        try { await refresh(undefined, true); } catch { setConflict(true); }
        if (mounted.current) {
          setPoster(null);
          setWarning("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
        }
        return null;
      }
      if (!mounted.current) return null;
      const fresh = await refresh(uploaded.version, true);
      if (!fresh) return null;
      saved = fresh; setPoster(null);
    }
    return saved;
  }
  // 依次保存单集字段、视频并按需发布，在单集提交时调用。
  async function saveEpisode(episode: EpisodeResponse, values: EpisodeFields, file: File | null, publish: boolean, onUploaded: () => void, onProgress: (progress: ApiUploadProgress) => void) {
    return run(async () => {
      const parent = current.current;
      if (!parent || !knownStatus(parent.status) || !canAct(episode, "edit")) return;
      // 单集字段先保存，再以上一步版本上传视频；失败时跳过发布并保留可重试输入。
      let saved = await updateEpisode(parent.id, episode.season_id, episode.id, { ...values, version: episode.version });
      if (!mounted.current) return;
      acceptEpisode(saved);
      if (file) {
        let uploaded;
        try {
          // 进度只回传给当前单集，避免其他单集的草稿被上传过程覆盖。
          uploaded = await uploadMedia({ kind: "episodes", id: episode.id, slot: "video" }, file, saved.episode.version, onProgress);
        } catch (cause) {
          const error = normalizeError(cause as CaughtValue);
          if (!(error instanceof ApiError) || apiErrorCode(error) !== "media_replace_finalization_failed") throw error;
          try { await refresh(); } catch { setConflict(true); }
          if (mounted.current) {
            onUploaded();
            setWarning("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
          }
          return;
        }
        if (!mounted.current) return;
        // 单集和父级版本都必须与原子上传结果一致，否则停止后续发布。
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
  // 获取最新删除影响并准备确认，管理员请求删除时调用。
  async function prepareDelete(seasonId?: string, episodeId?: string, loadedSeries?: SeriesResponse) {
    await run(async () => {
      // 先读取最新层级再查询目标影响；状态或目标已变化时不允许继续确认删除。
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
  const choices = mergeGenreChoices(genres, series?.genres ?? []);
  const deleteName = deleting ? "display_name" in deleting.impact ? deleting.impact.display_name : deleting.impact.name : "";
  return <section>
    <div inert={!!deleting}>
      <div className="admin-title-row"><div><p className="eyebrow">SERIES · {series ? statusNames[series.status] ?? "未知状态" : "新建"}</p><h1>{series ? series.status === "draft" ? "编辑剧集草稿" : "查看剧集" : "新建剧集草稿"}</h1></div><Button disabled={busy} onClick={onBack}>返回列表</Button></div>
      {!deleting && error && <div className="request-error"><p role="alert">{error}</p><Button disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}>重新加载</Button></div>}
      {!deleting && invalid.length > 0 && <SeriesPublishErrors fields={invalid} />}
      {notice && <p role="status">{notice}</p>}
      {warning && <p role="alert" className="error-message">{warning}</p>}
      {loading ? <p role="status">正在加载剧集…</p> : !series ? <form className="movie-form" onSubmit={(event) => {
        event.preventDefault(); if (!fields.name.trim()) return;
        void run(async () => {
          // 先保留已创建剧集的身份，再创建首季；首季失败仍可返回继续创建。
          const created = await createSeries(fields.name, isPrivate); if (!mounted.current) return;
          accept(created, true); onCreated(created.id);
          const saved = await createSeason(created.id, 1, created.version); if (!mounted.current) return;
          const seasonIds = saved.seasons.map((season) => season.id);
          setNewSeasons(seasonIds); setExpandedSeasons(new Set(seasonIds)); accept(saved);
        });
      }}><Field label="剧集名称" className="movie-field-medium"><input required disabled={locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field><PrivacySelector value={isPrivate} onChange={setIsPrivate} disabled={locked} series /><Button type="submit" disabled={locked} variant="primary">创建草稿</Button></form> : <>
        <section className="series-section" aria-labelledby="series-basic-title"><h2 id="series-basic-title">基本信息</h2>
          <div className="movie-editor-card"><PosterPicker current={series.poster} file={poster} onSelect={setPoster} readOnly={readOnly} disabled={locked} />
            <form className="movie-form" onSubmit={(event) => {
              // 提交时先保存基本信息及海报，只有全部成功且权限仍允许时才按新版本发布整剧。
              event.preventDefault(); if (!fields.name.trim()) return;
              const publish = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "publish";
              void run(async () => { const saved = await saveBasic(); if (!saved || !mounted.current) return; if (publish && canAct(saved, "publish")) { await transitionSeries(saved.id, "publish", saved.version); await refresh(undefined, true); } else setNotice("剧集草稿已保存。"); });
            }}>
              <Field label="剧集名称" className="movie-field-medium"><input required disabled={readOnly || locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field>
              <Field label="首播年份" className="movie-field-short"><input type="number" min="1" max="9999" disabled={readOnly || locked} value={fields.year} onChange={(e) => setFields({ ...fields, year: e.target.value })} /></Field>
              <Field label="简介" className="movie-field-wide"><textarea rows={4} disabled={readOnly || locked} value={fields.synopsis} onChange={(e) => setFields({ ...fields, synopsis: e.target.value })} /></Field>
              <Field label="题材" className="movie-field-medium"><select multiple size={3} disabled={readOnly || locked} value={fields.genreIds} onChange={(e) => {
                // 保留已绑定的停用题材，再合并新选择，避免表单编辑隐式丢失旧关联。
                const retained = fields.genreIds.filter((id) => choices.some((g) => g.id === id && !g.enabled));
                setFields({ ...fields, genreIds: [...new Set([...retained, ...Array.from(e.target.selectedOptions).map((o) => o.value)])] });
              }}>{choices.filter((g) => g.enabled || fields.genreIds.includes(g.id)).map((g) => <option key={g.id} value={g.id} disabled={!g.enabled}>{g.name}{g.enabled ? "" : "（已停用）"}</option>)}</select></Field>
              <PrivacySelector value={series.is_private} onChange={setIsPrivate} disabled series />
              <div className="movie-form-actions">
                {canAct(series, "edit") && <Button type="submit" disabled={locked}>保存剧集草稿</Button>}
                {canAct(series, "publish") && series.status === "draft" && <Button type="submit" value="publish" disabled={locked} variant="primary">发布剧集</Button>}
                {(["publish", "archive", "draft"] as const).filter((action) => canAct(series, action) && !(action === "publish" && series.status === "draft")).map((action) => <Button key={action} disabled={locked} onClick={() => { void run(async () => { /* 非草稿状态按钮仅转换生命周期，完成后刷新表单和层级版本。 */ await transitionSeries(series.id, action, series.version); await refresh(undefined, true); }); }}>{action === "archive" ? "归档剧集" : action === "draft" ? "剧集转为草稿" : "原样发布剧集"}</Button>)}
                {canAct(series, "delete") && <Button variant="danger" disabled={locked} onClick={() => { void prepareDelete(); }}>永久删除剧集</Button>}
              </div>
            </form>
          </div>
        </section>
        <section className="series-section" aria-labelledby="series-structure-title"><h2 id="series-structure-title">季与单集</h2><p>季只填写序号；每一集必须输入名称，独立保存草稿和上传视频。</p>
          {series.seasons.map((season) => <SeasonCard key={`${revision}:${season.id}`} series={series} season={season} disabled={locked} initialEpisode={newSeasons.includes(season.id)} expanded={expandedSeasons.has(season.id)} onToggle={() => setExpandedSeasons((ids) => {
            // 只切换当前季的展开状态，复制集合以触发渲染并保留其他季选择。
            const next = new Set(ids);
            if (next.has(season.id)) next.delete(season.id); else next.add(season.id);
            return next;
          })}
            actions={{ save: saveEpisode, /* 单集状态按钮触发时先检查权限，再按单集版本转换并刷新整剧层级。 */ transition: (episode, action) => { if (canAct(episode, action)) void run(async () => { await transitionEpisode(series.id, season.id, episode.id, action, episode.version); await refresh(); }); }, /* 单集删除入口先读取最新影响，确认后才允许实际删除。 */ remove: (episode) => { void prepareDelete(season.id, episode.id); } }}
            create={(number, name) => run(async () => { /* 提交新单集时重新检查父级与季权限，按父版本创建并接收最新层级。 */ if (!knownStatus(series.status) || !permits(series, "add_episode") || !permits(season, "add_episode")) return; const saved = await createEpisode(series.id, season.id, { version: series.version, number, name }); if (mounted.current) { accept(saved); setNotice("单集草稿已保存。"); } })}
            update={(number) => { /* 保存季号前检查是否可编辑，写入成功后采用返回的整剧版本。 */ if (canChangeSeason(series, season, "edit")) void run(async () => { const saved = await updateSeason(series.id, season.id, number, series.version); if (mounted.current) accept(saved); }); }}
            remove={() => { void prepareDelete(season.id); }} />)}
          <Button disabled={locked || !knownStatus(series.status) || !permits(series, "add_season")} onClick={() => { void run(async () => {
            // 用当前父级版本创建下一季；返回后仅展开新增季，保留其他季已有的展开状态。
            const saved = await createSeason(series.id, Math.max(0, ...series.seasons.map((s) => s.number)) + 1, series.version);
            if (mounted.current) {
              const createdIds = saved.seasons.filter((candidate) => !series.seasons.some((old) => old.id === candidate.id)).map((candidate) => candidate.id);
              accept(saved); setNewSeasons((ids) => [...ids, ...createdIds]); setExpandedSeasons((ids) => new Set([...ids, ...createdIds]));
            }
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
          // 使用影响查询返回的版本；媒体同步删除失败保留确认框，已提交但收尾失败则停止重试并警告。
          const target = deleting;
          try {
            if (target.episode && target.season) await deleteEpisode(target.series.id, target.season.id, target.episode.id, target.impact.version);
            else if (target.season) await deleteSeason(target.series.id, target.season.id, target.impact.version);
            else await deleteSeries(target.series.id, target.impact.version);
          } catch (cause) {
            const error = normalizeError(cause as CaughtValue);
            if (!(error instanceof ApiError) || apiErrorCode(error) !== "media_delete_finalization_failed") throw error;
            // 整剧已删除时返回列表；子项已删除时留在编辑页并刷新层级，刷新失败则锁定写入。
            if (!target.season) { if (mounted.current) { onDeleteFinalization(); onBack(); } return; }
            if (mounted.current) setDeleting(null);
            try { await refresh(); } catch { setConflict(true); }
            if (mounted.current) setWarning("内容已删除，但媒体文件清理未完成。请检查媒体目录权限并重启服务，系统将在启动时继续恢复。");
            return;
          }
          // 成功删除整剧返回列表；删除季或单集后保留当前页面并读取最新层级。
          if (!target.season) { if (mounted.current) { onDeleteSuccess(); onBack(); } return; }
          if (mounted.current) { setDeleting(null); setNotice("内容及其媒体文件已删除"); }
          await refresh();
        }); }}>确认永久删除</Button></div>
      </>}
    </Dialog>
  </section>;
}
