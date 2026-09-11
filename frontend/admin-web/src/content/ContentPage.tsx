import { useEffect, useRef, useState } from "react";
import { ApiError, listMovies, listSeries, transitionMovie, transitionSeries } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { availableActions, type ContentAction, type ContentRow } from "./ActionButtons";
import { ContentFilters, initialFilters } from "./ContentFilters";
import { ContentTable } from "./ContentTable";

export function ContentPage({ onExpired, onOpen }: {
  onExpired: () => void;
  onOpen: (row: ContentRow | null, action: "edit" | "view" | "delete" | "create") => void;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<ContentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useMounted();
  const operation = useRef(false);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    setRows([]);
    const query = { status: filters.status === "all" ? undefined : filters.status, name: filters.name || undefined };
    function watchSession<T>(request: Promise<T>): Promise<T> {
      return request.catch((cause: unknown) => {
        // Observe each request: Promise.all may already have rejected on the other list's 5xx.
        if (!ignore && cause instanceof ApiError && cause.status === 401) onExpired();
        throw cause;
      });
    }
    void Promise.all([
      filters.kind === "series" ? [] : watchSession(listMovies(query)),
      filters.kind === "movie" ? [] : watchSession(listSeries(query)),
    ]).then(([movies, series]) => {
      if (ignore) return;
      setRows([...movies.map((row): ContentRow => ({ ...row, kind: "movie" })), ...series.map((row): ContentRow => ({ ...row, kind: "series" }))]);
      setConflict(false);
    }).catch((cause: unknown) => {
      if (ignore) return;
      if (!(cause instanceof ApiError && cause.status === 401)) setError("内容列表加载失败，请重新加载。");
    }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [filters, revision, onExpired]);

  async function act(row: ContentRow, action: ContentAction) {
    if (operation.current || loading || conflict || !availableActions(row).includes(action)) return;
    if (action === "edit" || action === "view" || action === "delete") { onOpen(row, action); return; }
    operation.current = true;
    setMutating(true);
    setError("");
    try {
      await (row.kind === "movie" ? transitionMovie : transitionSeries)(row.id, action, row.version);
      if (mounted.current) setRevision((value) => value + 1);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else if (cause instanceof ApiError && cause.status === 403) {
        const recovery = await recoverForbiddenWrite();
        if (!mounted.current) return;
        if (recovery.expired) onExpired();
        else setError(recovery.message);
      } else if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        setError("内容已发生变化，请刷新后重试。");
      } else setError(cause instanceof ApiError ? `操作失败：${cause.message}` : "操作失败，请检查网络后重试。");
    } finally {
      operation.current = false;
      if (mounted.current) setMutating(false);
    }
  }

  return <section>
    <div className="admin-title-row"><div><p className="eyebrow">CONTENT</p><h1>内容管理</h1></div><Button variant="primary" onClick={() => onOpen(null, "create")} disabled={mutating}>＋ 新建内容</Button></div>
    <ContentFilters onQuery={setFilters} disabled={mutating} />
    {error && <div className="request-error"><p role="alert">{error}</p><Button onClick={() => setRevision((value) => value + 1)} disabled={loading || mutating}>重新加载</Button></div>}
    {loading ? <p role="status">正在加载内容…</p> : <>
      {rows.length === 0 && !error && <p role="status" className="empty-state">没有匹配的内容，请调整查询条件。</p>}
      <ContentTable rows={rows} disabled={mutating || conflict} onAction={(row, action) => { void act(row, action); }} />
    </>}
  </section>;
}
