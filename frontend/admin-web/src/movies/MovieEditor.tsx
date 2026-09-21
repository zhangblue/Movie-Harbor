import { useEffect, useRef, useState } from "react";
import { ApiError, apiErrorCode, createMovie, deleteMovie, getMovie, getMovieDeleteImpact, listGenres, transitionMovie, updateMovie, uploadMedia, type ApiUploadProgress, type DeleteImpactResponse, type GenreResponse, type MovieResponse } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { classifyEditorWriteError, mergeGenreChoices } from "../content/editorSupport";
import { PosterPicker } from "./PosterPicker";
import { VideoPicker } from "./VideoPicker";
import { PublishErrors } from "./PublishErrors";

type Fields = { name: string; synopsis: string; year: string; minutes: string; genreIds: string[] };
const empty: Fields = { name: "", synopsis: "", year: "", minutes: "", genreIds: [] };
const statusNames = { draft: "草稿", published: "已发布", archived: "已归档" };
function fieldsOf(movie: MovieResponse): Fields {
  return { name: movie.name, synopsis: movie.synopsis, year: movie.year?.toString() ?? "", minutes: movie.duration_seconds === null ? "" : String(movie.duration_seconds / 60), genreIds: movie.genres.map((g) => g.id) };
}

export function MovieEditor({ movieId, onBack, onExpired, onDeleteSuccess = () => {}, onDeleteFinalization = () => {}, initialDelete = false }: { movieId: string | null; onBack: () => void; onExpired: () => void; onDeleteSuccess?: () => void; onDeleteFinalization?: () => void; initialDelete?: boolean }) {
  const [movie, setMovie] = useState<MovieResponse | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
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

  function accept(value: MovieResponse) { setMovie(value); setFields(fieldsOf(value)); }
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError(""); setInvalid([]); setNotice(""); setWarning(""); setDeleting(null);
    setPoster(null); setVideo(null); setVideoUploadProgress(null);
    const watch = <T,>(promise: Promise<T>) => promise.catch((cause: unknown) => {
      if (!ignore && cause instanceof ApiError && cause.status === 401) onExpired();
      throw cause;
    });
    void Promise.all([id ? watch(getMovie(id)) : null, watch(listGenres())]).then(async ([value, choices]) => {
      if (ignore) return;
      setGenres(choices); setConflict(false);
      if (value) {
        accept(value);
        if (initialDelete && revision === 0 && value.status !== "published") {
          const impact = await watch(getMovieDeleteImpact(value.id));
          if (!ignore) { setDeleting(impact); setConfirmation(""); }
        }
      }
    }).catch((cause: unknown) => { if (!ignore && !(cause instanceof ApiError && cause.status === 401)) { setError("电影详情加载失败，请重新加载。"); setConflict(true); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
    // A new editor is keyed by movieId in App; revision is the explicit refresh boundary.
  }, [movieId, revision, onExpired]);

  async function fail(cause: unknown) {
    if (!mounted.current) return;
    if (cause instanceof ApiError && cause.status === 401) onExpired();
    else if (cause instanceof ApiError && cause.status === 403) {
      const recovery = await recoverForbiddenWrite();
      if (!mounted.current) return;
      if (recovery.expired) onExpired(); else setError(recovery.message);
    } else {
      const result = classifyEditorWriteError(cause);
      if (result.kind === "conflict") { setConflict(true); setDeleting(null); setError("内容已发生变化，请刷新后重试。"); }
      else if (result.kind === "validation") setInvalid(result.fields);
      else setError(result.message);
    }
  }
  async function run(action: () => Promise<void>) {
    if (operation.current || loading || conflict) return;
    operation.current = true; setBusy(true); setError(""); setInvalid([]); setNotice(""); setWarning("");
    try { await action(); } catch (cause) { await fail(cause); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function refreshAfterWrite() {
    if (!id || !mounted.current) return;
    // A lost follow-up read must not leave the previous version writable.
    setConflict(true);
    const fresh = await getMovie(id);
    if (mounted.current) { accept(fresh); setConflict(false); }
  }
  async function saveDraft(): Promise<MovieResponse | null> {
    if (!movie || movie.status !== "draft") return null;
    let saved = await updateMovie(movie.id, {
      version: movie.version, name: fields.name, synopsis: fields.synopsis,
      year: fields.year === "" ? null : Number(fields.year),
      duration_seconds: fields.minutes === "" ? null : Math.round(Number(fields.minutes) * 60), genre_ids: fields.genreIds,
    });
    if (!mounted.current) return null;
    accept(saved);
    for (const [slot, file] of [["poster", poster], ["video", video]] as const) {
      if (!file) continue;
      let uploaded;
      try {
        uploaded = await uploadMedia(
          { kind: "movies", id: saved.id, slot },
          file,
          saved.version,
          slot === "video" ? setVideoUploadProgress : undefined,
        );
      } catch (cause) {
        if (!(cause instanceof ApiError) || apiErrorCode(cause) !== "media_replace_finalization_failed") throw cause;
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
      // Upload already atomically associates the file; an extra association PUT would be incorrect.
      setMovie({ ...saved, version: uploaded.version });
      setConflict(true);
      saved = await getMovie(saved.id);
      if (!mounted.current) return null;
      if (saved.version !== uploaded.version) {
        throw new ApiError(409, "Conflict", "Content changed after upload", undefined);
      }
      accept(saved); setConflict(false);
      if (slot === "poster") setPoster(null); else setVideo(null);
    }
    return saved;
  }
  async function save(publish: boolean) {
    await run(async () => {
      const saved = await saveDraft();
      if (!saved || !mounted.current) return;
      if (publish) { await transitionMovie(saved.id, "publish", saved.version); await refreshAfterWrite(); }
      else setNotice("草稿已保存。");
    });
  }
  async function transition(action: "publish" | "archive" | "draft") {
    if (!movie) return;
    await run(async () => { await transitionMovie(movie.id, action, movie.version); await refreshAfterWrite(); });
  }
  async function prepareDelete(targetId = movie?.id) {
    if (!targetId || movie?.status === "published") return;
    await run(async () => {
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
        event.preventDefault(); void run(async () => { const created = await createMovie(fields.name); if (mounted.current) accept(created); });
      }}><Field label="名称" className="movie-field-medium"><input required value={fields.name} disabled={locked} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field><Button variant="primary" type="submit" disabled={locked}>创建草稿</Button></form> : <div className="movie-editor-card">
        <PosterPicker current={movie.poster} file={poster} onSelect={setPoster} readOnly={readOnly} disabled={locked} />
        <form className="movie-form" onSubmit={(event) => { event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter; void save(submitter?.getAttribute("value") === "publish"); }}>
          <Field label="名称" className="movie-field-medium"><input required disabled={readOnly || locked} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></Field>
          <div className="movie-inline-fields">
            <Field label="年份" className="movie-field-short"><input type="number" min="1" max="9999" disabled={readOnly || locked} value={fields.year} onChange={(e) => setFields({ ...fields, year: e.target.value })} /></Field>
            <Field label="时长（分钟）" className="movie-field-short"><input type="number" min="0" step="any" disabled={readOnly || locked} value={fields.minutes} onChange={(e) => setFields({ ...fields, minutes: e.target.value })} /></Field>
          </div>
          <Field label="简介" className="movie-field-wide"><textarea rows={4} disabled={readOnly || locked} value={fields.synopsis} onChange={(e) => setFields({ ...fields, synopsis: e.target.value })} /></Field>
          <Field label="题材" className="movie-field-medium"><select multiple size={3} disabled={readOnly || locked} value={fields.genreIds} onChange={(e) => {
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
        <div className="dialog-actions"><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={locked || confirmation !== deleting.name} onClick={() => { void run(async () => { if (!movie) return; try { await deleteMovie(movie.id, deleting.version); } catch (cause) { if (cause instanceof ApiError && apiErrorCode(cause) === "media_delete_finalization_failed") { if (mounted.current) { onDeleteFinalization(); onBack(); } return; } throw cause; } if (mounted.current) { onDeleteSuccess(); onBack(); } }); }}>确认永久删除</Button></div>
      </>}
    </Dialog>
  </section>;
}
