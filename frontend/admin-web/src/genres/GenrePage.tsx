import { FormEvent, useEffect, useState } from "react";
import { ApiError, normalizeError, type CaughtValue, createGenre, deactivateGenre, deleteGenre, listGenres, renameGenre, reorderGenres, type GenreResponse } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";

export function GenrePage({ onExpired }: { onExpired: () => void }) {
  const [genres, setGenres] = useState<GenreResponse[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useMounted();

  useEffect(() => {
    void listGenres().then((items) => {
      if (mounted.current) setGenres(items);
    }).catch((cause: CaughtValue) => {
      const error = normalizeError(cause);
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) onExpired();
      else setError("无法读取题材，请稍后重试。");
    }).finally(() => {
      if (mounted.current) setLoading(false);
    });
  }, [mounted, onExpired]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || busy) return;
    setBusy(true);
    setError("");
    try {
      const genre = await createGenre(normalized);
      if (!mounted.current) return;
      setGenres((items) => [...items, genre].sort((left, right) => left.sort_order - right.sort_order));
      setName("");
    } catch (cause) {
      const error = normalizeError(cause as CaughtValue);
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) onExpired();
      else if (error instanceof ApiError && error.status === 409) setError("题材名称已存在。");
      else setError("新增题材失败，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function mutate(action: () => Promise<GenreResponse[] | GenreResponse | void>, accept: (value: GenreResponse[] | GenreResponse | void) => void, conflict: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      if (mounted.current) accept(value);
    } catch (cause) {
      const error = normalizeError(cause as CaughtValue);
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) onExpired();
      else if (error instanceof ApiError && error.status === 409) setError(conflict);
      else setError("题材操作失败，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function replace(updated: GenreResponse) {
    setGenres((items) => items.map((item) => item.id === updated.id ? updated : item));
  }

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= genres.length) return;
    const ordered = [...genres];
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    void mutate(
      () => reorderGenres(ordered.map((genre, position) => ({ id: genre.id, sort_order: position + 1 }))),
      (value) => setGenres(value as GenreResponse[]),
      "题材顺序已变化，请刷新后重试。",
    );
  }

  return <section>
    <div className="admin-title-row"><div><h1>题材配置</h1><p>新增题材后，可在电影和剧集草稿中选择。</p></div></div>
    <form className="filter-bar genre-create" onSubmit={(event) => { void submit(event); }}>
      <Field label="题材名称"><input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Button type="submit" disabled={busy || !name.trim()}>{busy ? "正在新增…" : "新增题材"}</Button>
    </form>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="table-card"><table className="content-table genre-table"><thead><tr><th scope="col">题材名称</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
      <tbody>{genres.map((genre, index) => <GenreRow key={genre.id} genre={genre} busy={busy} first={index === 0} last={index === genres.length - 1}
        onRename={(value) => { void mutate(() => renameGenre(genre.id, value), (updated) => replace(updated as GenreResponse), "题材名称已存在。"); }}
        onMove={(offset) => move(index, offset)}
        onDeactivate={() => { void mutate(() => deactivateGenre(genre.id), (updated) => replace(updated as GenreResponse), "题材状态已变化，请刷新后重试。"); }}
        onDelete={() => { if (window.confirm(`确认永久删除题材“${genre.name}”？`)) void mutate(() => deleteGenre(genre.id), () => setGenres((items) => items.filter((item) => item.id !== genre.id)), "题材正在被内容引用，不能删除。"); }} />)}</tbody>
    </table>{loading ? <p role="status" className="empty-state">正在加载题材…</p> : genres.length === 0 ? <p className="empty-state">尚无题材。</p> : null}</div>
  </section>;
}

function GenreRow({ genre, busy, first, last, onRename, onMove, onDeactivate, onDelete }: {
  genre: GenreResponse; busy: boolean; first: boolean; last: boolean;
  onRename: (name: string) => void; onMove: (offset: number) => void; onDeactivate: () => void; onDelete: () => void;
}) {
  const [name, setName] = useState(genre.name);
  useEffect(() => setName(genre.name), [genre.name]);
  return <tr>
    <th scope="row"><input aria-label={`编辑题材 ${genre.name}`} maxLength={50} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></th>
    <td>{genre.enabled ? "启用" : "停用"}</td>
    <td className="action-cell"><div className="row-actions">
      <Button compact disabled={busy || !name.trim() || name.trim() === genre.name} onClick={() => onRename(name.trim())} aria-label={`保存 ${genre.name}`}>保存</Button>
      <Button compact disabled={busy || first} onClick={() => onMove(-1)} aria-label={`上移 ${genre.name}`}>上移</Button>
      <Button compact disabled={busy || last} onClick={() => onMove(1)} aria-label={`下移 ${genre.name}`}>下移</Button>
      <Button compact disabled={busy || !genre.enabled} onClick={onDeactivate} aria-label={`停用 ${genre.name}`}>停用</Button>
      <Button compact variant="danger" disabled={busy} onClick={onDelete} aria-label={`删除 ${genre.name}`}>删除</Button>
    </div></td>
  </tr>;
}
