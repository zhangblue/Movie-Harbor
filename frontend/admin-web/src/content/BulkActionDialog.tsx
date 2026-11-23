import { useState } from "react";
import type { AdminBulkActionRequest, AdminBulkProblem, GenreResponse } from "@movie-harbor/api-client";
import { Button, Dialog } from "@movie-harbor/ui";
import type { ContentRow } from "./ActionButtons";

// 表示列表可打开的三类批量确认界面。
export type BulkDialogAction = "privacy" | "genres" | "archive";

// 将当前页选中行转换为后端所需的乐观锁目标，确保提交使用界面显示版本。
function targets(rows: ContentRow[]) {
  return rows.map(({ kind, id, version }) => ({ kind, id, version }));
}

// 将稳定批量问题转换为不泄漏服务器当前版本的中文提示。
function problemMessage(problem: AdminBulkProblem): string {
  if (problem.scope === "genre") return problem.reason === "inactive" ? "所选题材已停用" : "所选题材不存在";
  if (problem.reason === "version_conflict") return "内容版本已变化";
  if (problem.reason === "invalid_state") return "内容当前状态不允许此操作";
  return "内容不存在";
}

// 展示批量访问范围、题材或归档确认内容，并只提交一次判别联合请求。
export function BulkActionDialog({ action, rows, genres, pending, problems, error = "", onClose, onSubmit }: {
  action: BulkDialogAction;
  rows: ContentRow[];
  genres: GenreResponse[];
  pending: boolean;
  problems: AdminBulkProblem[];
  error?: string;
  onClose: () => void;
  onSubmit: (request: AdminBulkActionRequest) => void;
}) {
  const [isPrivate, setIsPrivate] = useState(false);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [genreIds, setGenreIds] = useState<Set<string>>(new Set());
  const title = action === "privacy" ? "批量设置访问范围" : action === "genres" ? "批量调整题材" : "批量归档内容";
  const choices = action === "genres" ? genres.filter((genre) => mode === "remove" || genre.enabled) : [];

  // 切换题材勾选，在确认时提交当前模式下明确选择的标识。
  function toggleGenre(id: string) {
    setGenreIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // 按当前对话框字段构造唯一批量请求，避免页面循环调用单条接口。
  function submit() {
    const selectedTargets = targets(rows);
    if (action === "privacy") onSubmit({ action: "set_privacy", is_private: isPrivate, targets: selectedTargets });
    else if (action === "genres") onSubmit({ action: "update_genres", mode, genre_ids: [...genreIds], targets: selectedTargets });
    else onSubmit({ action: "archive", targets: selectedTargets });
  }

  return <Dialog open title={title} className="bulk-action-dialog" onClose={() => { if (!pending) onClose(); }}>
    <p>将对当前页选中的 {rows.length} 项内容执行一次原子操作。</p>
    {action === "privacy" && <fieldset className="bulk-choice-group" disabled={pending}>
      <legend>目标访问范围</legend>
      <label><input type="radio" name="bulk-privacy" checked={!isPrivate} onChange={() => setIsPrivate(false)} />公开</label>
      <label><input type="radio" name="bulk-privacy" checked={isPrivate} onChange={() => setIsPrivate(true)} />私密</label>
    </fieldset>}
    {action === "genres" && <>
      <fieldset className="bulk-choice-group" disabled={pending}>
        <legend>调整方式</legend>
        <label><input type="radio" name="bulk-genre-mode" checked={mode === "add"} onChange={() => { setMode("add"); setGenreIds(new Set()); }} />添加题材</label>
        <label><input type="radio" name="bulk-genre-mode" checked={mode === "remove"} onChange={() => { setMode("remove"); setGenreIds(new Set()); }} />移除题材</label>
      </fieldset>
      <fieldset className="bulk-genre-list" disabled={pending}>
        <legend>题材</legend>
        {choices.map((genre) => <label key={genre.id}><input type="checkbox" checked={genreIds.has(genre.id)} onChange={() => toggleGenre(genre.id)} />{genre.name}{genre.enabled ? "" : "（已停用）"}</label>)}
      </fieldset>
    </>}
    {action === "archive" && <p>仅已发布内容可以归档；任一目标状态或版本不匹配时整批不会写入。</p>}
    {(error || problems.length > 0) && <div role="alert" className="error-message">
      {error && <p>{error}</p>}
      {problems.map((problem, index) => <p key={`${problem.scope}:${index}`}>{problemMessage(problem)}</p>)}
    </div>}
    <div className="dialog-actions">
      <Button onClick={onClose} disabled={pending}>取消</Button>
      <Button variant={action === "archive" ? "danger" : "primary"} disabled={pending || (action === "genres" && genreIds.size === 0)} onClick={submit}>
        {action === "privacy" ? "确认设置" : action === "genres" ? "确认调整题材" : "确认归档"}
      </Button>
    </div>
  </Dialog>;
}
