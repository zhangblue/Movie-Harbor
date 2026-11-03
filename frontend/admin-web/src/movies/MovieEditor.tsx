import { useEffect, useRef, useState } from "react";
import { ApiError, normalizeError, type CaughtValue, apiErrorCode, createMovie, deleteMovie, getMovie, getMovieDeleteImpact, listGenres, transitionMovie, updateMovie, uploadMedia, type ApiUploadProgress, type DeleteImpactResponse, type GenreResponse, type MovieResponse } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { classifyEditorWriteError, mergeGenreChoices } from "../content/editorSupport";
import { PrivacySelector } from "../content/PrivacySelector";
import { PosterPicker } from "./PosterPicker";
import { VideoPicker } from "./VideoPicker";
import { PublishErrors } from "./PublishErrors";

// 保存编辑表单字段，在详情与表单之间转换时使用。
type Fields = { name: string; synopsis: string; year: string; minutes: string; genreIds: string[] };
const empty: Fields = { name: "", synopsis: "", year: "", minutes: "", genreIds: [] };
const statusNames = { draft: "草稿", published: "已发布", archived: "已归档" };
// 将服务端详情转换为编辑表单字段，在加载或刷新详情时使用。
function fieldsOf(movie: MovieResponse): Fields {
  return { name: movie.name, synopsis: movie.synopsis, year: movie.year?.toString() ?? "", minutes: movie.duration_seconds === null ? "" : String(movie.duration_seconds / 60), genreIds: movie.genres.map((g) => g.id) };
}

// 管理电影详情、媒体、状态和删除流程，在打开电影编辑页时使用。
export function MovieEditor({ movieId, onBack, onExpired, onDeleteSuccess = () => {}, onDeleteFinalization = () => {}, initialDelete = false }: { movieId: string | null; onBack: () => void; onExpired: () => void; onDeleteSuccess?: () => void; onDeleteFinalization?: () => void; initialDelete?: boolean }) {
  const [movie, setMovie] = useState<MovieResponse | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
  const [isPrivate, setIsPrivate] = useState(false);
  const [genres, setGenres] = useState<GenreResponse[]>([]);
  const [poster, setPoster] = useState<File | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [videoUploadProgress, setVideoUploadProgress] = useState<ApiUploadProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState<DeleteImpactResponse | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const operation = useRef(false);
  const mounted = useMounted();
  const id = movie?.id ?? movieId;

  // 接收服务端最新详情并同步界面，在加载或成功写入后调用。
  function accept(value: MovieResponse) { setMovie(value); setFields(fieldsOf(value)); }
  // 同步视频上传进度，上传事件到达且页面仍挂载时调用。
  function updateVideoUploadProgress(progress: ApiUploadProgress) {
    if (mounted.current) setVideoUploadProgress(progress);
  }
  // 打开电影或主动刷新时并行读取详情和题材；旧请求清理后不得覆盖新编辑状态。
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError(""); setInvalid([]); setNotice(""); setWarning(""); setDeleting(null);
    setPoster(null); setVideo(null); setVideoUploadProgress(null);
    // 检查异步请求的会话失效状态，在并行加载详情时调用。
    const watch = <T,>(promise: Promise<T>) => promise.catch((cause: CaughtValue) => {
      const error = normalizeError(cause);
      if (!ignore && error instanceof ApiError && error.status === 401) onExpired();
      throw error;
    });
    void Promise.all([id ? watch(getMovie(id)) : null, watch(listGenres())]).then(async ([value, choices]) => {
      // 详情和题材都就绪后接收编辑状态；从列表删除入口进入时再读最新影响，失败保持锁定。
      if (ignore) return;
      setGenres(choices); setConflict(false);
      if (value) {
        accept(value);
        if (initialDelete && revision === 0 && value.status !== "published") {
          const impact = await watch(getMovieDeleteImpact(value.id));
          if (!ignore) { setDeleting(impact); setConfirmation(""); }
        }
      }
    }).catch((cause: CaughtValue) => { const error = normalizeError(cause); if (!ignore && !(error instanceof ApiError && error.status === 401)) { setError("电影详情加载失败，请重新加载。"); setConflict(true); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
    // App 按电影 ID 区分编辑器；revision 是主动刷新并丢弃旧加载结果的边界。
  }, [movieId, revision, onExpired]);

  // 按会话、冲突和校验错误更新反馈，在写入失败时调用。
  async function fail(error: Error) {
    if (!mounted.current) return;
    if (error instanceof ApiError && error.status === 401) onExpired();
    else if (error instanceof ApiError && error.status === 403) {
      // 写入被拒后先确认会话并更新令牌；保留用户操作供其明确重试，避免重复写入。
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
  async function run(action: () => Promise<void>) {
    if (operation.current || loading || conflict) return;
    operation.current = true; setBusy(true); setError(""); setInvalid([]); setNotice(""); setWarning("");
    try { await action(); } catch (cause) { const error = normalizeError(cause as CaughtValue); await fail(error); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  // 写入后重新读取电影权威版本，读取失败时保持写入锁定。
  async function refreshAfterWrite() {
    if (!id || !mounted.current) return;
    // 后续读取失败时保持锁定，避免继续使用写入前的旧版本。
    setConflict(true);
    const fresh = await getMovie(id);
    if (mounted.current) { accept(fresh); setConflict(false); }
  }
  // 依次保存电影字段和待替换媒体，保存或发布草稿时调用。
  async function saveDraft(): Promise<MovieResponse | null> {
    if (!movie || movie.status !== "draft") return null;
    let saved = await updateMovie(movie.id, {
      version: movie.version, name: fields.name, synopsis: fields.synopsis,
      year: fields.year === "" ? null : Number(fields.year),
      duration_seconds: fields.minutes === "" ? null : Math.round(Number(fields.minutes) * 60), genre_ids: fields.genreIds,
    });
    if (!mounted.current) return null;
    accept(saved);
    // 字段先保存，海报和视频依次使用上一步返回的版本；任一失败即停止后续操作。
    for (const [slot, file] of [["poster", poster], ["video", video]] as const) {
      if (!file) continue;
      let uploaded;
      try {
        uploaded = await uploadMedia(
          { kind: "movies", id: saved.id, slot },
          file,
          saved.version,
          // 仅视频上传上报进度；组件卸载后的事件由回调忽略。
          slot === "video" ? updateVideoUploadProgress : undefined,
        );
      } catch (cause) {
        const error = normalizeError(cause as CaughtValue);
        if (!(error instanceof ApiError) || apiErrorCode(error) !== "media_replace_finalization_failed") throw error;
        try { await refreshAfterWrite(); } catch { setConflict(true); }
        if (mounted.current) {
          if (slot === "poster") setPoster(null); else setVideo(null);
          setWarning("媒体已更新，但媒体存储收尾未完成。系统将在服务下次启动时继续恢复，请稍后刷新确认。");
        }
        return null;
      } finally {
        if (slot === "video" && mounted.current) setVideoUploadProgress(null);
      }
      if (!mounted.current) return null;
      // 上传已原子关联文件；再次发送关联请求会错误地重复操作。
      setMovie({ ...saved, version: uploaded.version });
      setConflict(true);
      saved = await getMovie(saved.id);
      if (!mounted.current) return null;
      // 若上传后发生并发写入，停止剩余媒体和发布，要求用户刷新最新版本。
      if (saved.version !== uploaded.version) {
        throw new ApiError(409, "Conflict", "Content changed after upload", undefined);
      }
      accept(saved); setConflict(false);
      if (slot === "poster") setPoster(null); else setVideo(null);
    }
    return saved;
  }
  // 先保存草稿并按需发布，表单提交时调用。
  async function save(publish: boolean) {
    await run(async () => {
      const saved = await saveDraft();
      if (!saved || !mounted.current) return;
      // 仅在草稿和媒体全部保存后发布，随后刷新状态以免继续使用旧版本。
      if (publish) { await transitionMovie(saved.id, "publish", saved.version); await refreshAfterWrite(); }
      else setNotice("草稿已保存。");
    });
  }
  // 使用当前版本转换电影状态，管理员选择发布、归档或转草稿时调用。
  async function transition(action: "publish" | "archive" | "draft") {
    if (!movie) return;
    await run(async () => { await transitionMovie(movie.id, action, movie.version); await refreshAfterWrite(); });
  }
  // 获取最新删除影响并准备确认，管理员请求删除时调用。
  async function prepareDelete(targetId = movie?.id) {
    if (!targetId || movie?.status === "published") return;
    await run(async () => {
      // 删除确认显示服务端最新影响及版本；读取失败时不打开确认框。
      const fresh = await getMovieDeleteImpact(targetId);
      if (!mounted.current) return;
      setConfirmation(""); setDeleting(fresh);
    });
  }
  const locked = busy || loading || conflict;
  const readOnly = movie?.status !== "draft";
  const choices = mergeGenreChoices(genres, movie?.genres ?? []);
  return <section>
    <div inert={!!deleting}>
      <div className="admin-title-row"><div><p className="eyebrow">MOVIE · {movie ? statusNames[movie.status] : "新建"}</p><h1>{movie ? movie.status === "draft" ? "编辑电影草稿" : "查看电影" : "新建电影草稿"}</h1></div><Button disabled={busy} onClick={onBack}>返回列表</Button></div>
      {!deleting && error && <div className="request-error"><p role="alert">{error}</p><Button disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}>重新加载</Button></div>}
      {!deleting && invalid.length > 0 && <PublishErrors fields={invalid} />}
      {notice && <p role="status">{notice}</p>}
      {warning && <p role="alert" className="error-message">{warning}</p>}
      {loading ? <p role="status">正在加载电影…</p> : !movie ? <form className="movie-form" onSubmit={(event) => {
        // 首次提交只创建草稿并接收服务端身份，后续字段和媒体保存复用同一编辑器。
        event.preventDefault(); void run(async () => { const created = await createMovie(fields.name, isPrivate); if (mounted.current) accept(created); });
      }}><Field label="名称" className="movie-field-medium"><input required value={fields.name} disabled={locked} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field><PrivacySelector value={isPrivate} onChange={setIsPrivate} disabled={locked} /><Button variant="primary" type="submit" disabled={locked}>创建草稿</Button></form> : <div className="movie-editor-card">
        <PosterPicker current={movie.poster} file={poster} onSelect={setPoster} readOnly={readOnly} disabled={locked} />
        <form className="movie-form" onSubmit={(event) => { /* 区分保存和发布按钮，把发布意图交给先保存媒体再发布的统一流程。 */ event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter; void save(submitter?.getAttribute("value") === "publish"); }}>
          <Field label="名称" className="movie-field-medium"><input required disabled={readOnly || locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field>
          <PrivacySelector value={movie.is_private} onChange={setIsPrivate} disabled />
          <div className="movie-inline-fields">
            <Field label="年份" className="movie-field-short"><input type="number" min="1" max="9999" disabled={readOnly || locked} value={fields.year} onChange={(e) => setFields({ ...fields, year: e.target.value })} /></Field>
            <Field label="时长（分钟）" className="movie-field-short"><input type="number" min="0" step="any" disabled={readOnly || locked} value={fields.minutes} onChange={(e) => setFields({ ...fields, minutes: e.target.value })} /></Field>
          </div>
          <Field label="简介" className="movie-field-wide"><textarea rows={4} disabled={readOnly || locked} value={fields.synopsis} onChange={(e) => setFields({ ...fields, synopsis: e.target.value })} /></Field>
          <Field label="题材" className="movie-field-medium"><select multiple size={3} disabled={readOnly || locked} value={fields.genreIds} onChange={(e) => {
            // 已绑定但停用的题材无法重新选择，合并时保留这些关联以免编辑其他项意外删去。
            const retained = fields.genreIds.filter((genreId) => choices.some((g) => g.id === genreId && !g.enabled));
            setFields({ ...fields, genreIds: [...new Set([...retained, ...Array.from(e.target.selectedOptions).map((option) => option.value)])] });
          }}>{choices.filter((g) => g.enabled || fields.genreIds.includes(g.id)).map((g) => <option key={g.id} value={g.id} disabled={!g.enabled}>{g.name}{!g.enabled ? "（已停用）" : ""}</option>)}</select></Field>
          <VideoPicker current={movie.video} file={video} onSelect={setVideo} readOnly={readOnly} disabled={locked} progress={videoUploadProgress} />
          <div className="movie-form-actions">
            {movie.status === "draft" && <><Button type="submit" disabled={locked}>保存草稿</Button><Button variant="primary" type="submit" value="publish" disabled={locked}>发布</Button></>}
            {movie.status === "published" && <Button disabled={locked} onClick={() => { void transition("archive"); }}>归档</Button>}
            {movie.status === "archived" && <><Button disabled={locked} onClick={() => { void transition("publish"); }}>原样发布</Button><Button disabled={locked} onClick={() => { void transition("draft"); }}>转为草稿</Button></>}
            {movie.status !== "published" && <Button variant="danger" disabled={locked} onClick={() => { void prepareDelete(); }}>永久删除</Button>}
          </div>
        </form>
      </div>}
    </div>
    <Dialog open={!!deleting} title="永久删除电影" onClose={() => { if (!busy) setDeleting(null); }}>
      {deleting && <><p>将永久删除“{deleting.name}”，不可恢复，没有回收站。</p><p>根据服务器最新删除影响，影响范围：</p><ul><li>季：{deleting.season_count}</li><li>单集：{deleting.episode_count}</li><li>媒体文件：{deleting.media_count}</li></ul>
        {error && <p role="alert" className="error-message">{error}</p>}
        <Field label="输入完整内容名称"><input disabled={busy} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
        <div className="dialog-actions"><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={locked || confirmation !== deleting.name} onClick={() => { /* 使用删除影响返回的版本；媒体同步删除失败保留确认框和输入，已提交但收尾失败则返回列表并警告，成功则返回并刷新列表。 */ void run(async () => { if (!movie) return; try { await deleteMovie(movie.id, deleting.version); } catch (cause) { const error = normalizeError(cause as CaughtValue); if (error instanceof ApiError && apiErrorCode(error) === "media_delete_finalization_failed") { if (mounted.current) { onDeleteFinalization(); onBack(); } return; } throw error; } if (mounted.current) { onDeleteSuccess(); onBack(); } }); }}>确认永久删除</Button></div>
      </>}
    </Dialog>
  </section>;
}
