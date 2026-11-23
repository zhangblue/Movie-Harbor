import { useEffect, useRef, useState } from "react";
import { ActionButtons, type ContentAction, type ContentRow } from "./ActionButtons";

// 展示内容列表中的海报或占位图，在渲染内容行时使用。
function Poster({ row }: { row: ContentRow }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = row.poster_url;
  return url && url !== failedUrl
    ? <img className="table-poster" src={url} alt={`${row.name}海报`} loading="lazy" onError={() => setFailedUrl(url)} />
    : <span className="table-poster poster-placeholder" aria-label={`${row.name}暂无海报`}>暂无<br />海报</span>;
}
// 展示内容行与可用操作，在列表数据加载后使用。
export function ContentTable({ rows, startIndex, disabled, selected, problemKeys, stale, onSelect, onSelectAll, onAction }: {
  rows: ContentRow[];
  startIndex: number;
  disabled: boolean;
  selected: Set<string>;
  problemKeys: Set<string>;
  stale: boolean;
  onSelect: (row: ContentRow, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onAction: (row: ContentRow, action: ContentAction) => void;
}) {
  const statuses: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
  const selectAll = useRef<HTMLInputElement>(null);
  const selectedCount = rows.filter((row) => selected.has(`${row.kind}:${row.id}`)).length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && selectedCount < rows.length; }, [rows.length, selectedCount]);
  return <div className="table-card" role="region" aria-label="内容列表" tabIndex={0} data-stale={stale ? "true" : undefined}>
    <table className="content-table">
      <thead><tr><th scope="col" className="selection-cell"><input ref={selectAll} type="checkbox" aria-label="选择当前页全部内容" checked={rows.length > 0 && selectedCount === rows.length} disabled={disabled || rows.length === 0} onChange={(event) => onSelectAll(event.currentTarget.checked)} /></th><th scope="col" className="sequence-cell">序号</th><th scope="col">海报</th><th scope="col">名称</th><th scope="col">形态</th><th scope="col">状态</th><th scope="col">访问范围</th><th scope="col" className="action-cell">可用操作</th></tr></thead>
      <tbody>{rows.map((row, index) => {
        const key = `${row.kind}:${row.id}`;
        return <tr key={key} data-bulk-error={problemKeys.has(key) ? "true" : undefined}>
        <td className="selection-cell"><input type="checkbox" aria-label={`选择${row.name}`} checked={selected.has(key)} disabled={disabled} onChange={(event) => onSelect(row, event.currentTarget.checked)} /></td>
        <td className="sequence-cell">{startIndex + index + 1}</td><td><Poster row={row} /></td><th scope="row">{row.name}</th><td>{row.kind === "movie" ? "电影" : "剧集"}</td>
        <td><span className={`status status--${row.status}`}>{statuses[row.status] ?? "未知状态"}</span></td>
        <td><span className={`privacy-badge${row.is_private ? " private" : ""}`}>{row.is_private ? "私密" : "公开"}</span></td>
        <td className="action-cell"><ActionButtons row={row} disabled={disabled} onAction={onAction} /></td>
      </tr>})}</tbody>
    </table>
  </div>;
}
