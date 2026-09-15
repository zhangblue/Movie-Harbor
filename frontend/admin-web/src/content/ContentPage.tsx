import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError, listAdminContent, transitionMovie, transitionSeries, type AdminContentPage } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";
import { availableActions, type ContentAction, type ContentRow } from "./ActionButtons";
import { ContentFilters, initialFilters, type Filters } from "./ContentFilters";
import { ContentPagination } from "./ContentPagination";
import { ContentTable } from "./ContentTable";

export type ContentListState = { filters: Filters; page: number; revision: number };
export const initialContentListState: ContentListState = { filters: initialFilters, page: 1, revision: 0 };

export function ContentPage({ state, setState, onExpired, onOpen }: {
  state: ContentListState;
  setState: Dispatch<SetStateAction<ContentListState>>;
  onExpired: () => void;
  onOpen: (row: ContentRow | null, action: "edit" | "view" | "delete" | "create") => void;
}) {
  const [data, setData] = useState<AdminContentPage | null>(null);
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
    void listAdminContent({
      kind: state.filters.kind,
      status: state.filters.status === "all" ? undefined : state.filters.status,
      name: state.filters.name || undefined,
      page: state.page,
    }).then((result) => {
      if (ignore) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.size));
      if (state.page > lastPage) {
        setState((value) => ({ ...value, page: lastPage }));
        return;
      }
      setData(result);
      setConflict(false);
    }).catch((cause: unknown) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("内容列表加载失败，请重新加载。");
    }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [state.filters, state.page, state.revision, setState, onExpired]);

  async function act(row: ContentRow, action: ContentAction) {
    if (operation.current || loading || conflict || !availableActions(row).includes(action)) return;
    if (action === "edit" || action === "view" || action === "delete") { onOpen(row, action); return; }
    operation.current = true;
    setMutating(true);
    setError("");
    try {
      await (row.kind === "movie" ? transitionMovie : transitionSeries)(row.id, action, row.version);
      if (mounted.current) setState((value) => ({ ...value, revision: value.revision + 1 }));
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

  const rows = data?.items ?? [];
  return <section>
    <div className="admin-title-row"><div><p className="eyebrow">CONTENT</p><h1>内容管理</h1></div><Button variant="primary" onClick={() => onOpen(null, "create")} disabled={mutating}>＋ 新建内容</Button></div>
    <ContentFilters initialValue={state.filters} onQuery={(filters) => {
      setState((value) => ({ ...value, filters, page: 1 }));
    }} disabled={mutating} />
    {error && <div className="request-error"><p role="alert">{error}</p><Button onClick={() => setState((value) => ({ ...value, revision: value.revision + 1 }))} disabled={loading || mutating}>重新加载</Button></div>}
    {loading && <p role="status">正在加载内容…</p>}
    {data && <>
      {rows.length === 0 && !error && !loading && <p role="status" className="empty-state">没有匹配的内容，请调整查询条件。</p>}
      <ContentTable rows={rows} startIndex={(data.page - 1) * data.size} disabled={loading || mutating || conflict} onAction={(row, action) => { void act(row, action); }} />
    </>}
    <div className="content-pagination-slot">
      {data && <ContentPagination page={data.page} size={data.size} total={data.total} disabled={loading || mutating}
        onPage={(page) => setState((value) => ({ ...value, page }))} />}
    </div>
  </section>;
}
