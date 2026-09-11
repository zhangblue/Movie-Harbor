import { useState } from "react";
import { ActionButtons, type ContentAction, type ContentRow } from "./ActionButtons";

function Poster({ row }: { row: ContentRow }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = row.poster?.url;
  return url && url !== failedUrl
    ? <img className="table-poster" src={url} alt={`${row.name}海报`} loading="lazy" onError={() => setFailedUrl(url)} />
    : <span className="table-poster poster-placeholder" aria-label={`${row.name}暂无海报`}>暂无<br />海报</span>;
}
export function ContentTable({ rows, disabled, onAction }: {
  rows: ContentRow[]; disabled: boolean; onAction: (row: ContentRow, action: ContentAction) => void;
}) {
  const statuses: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
  return <div className="table-card" role="region" aria-label="内容列表" tabIndex={0}>
    <table className="content-table">
      <thead><tr><th scope="col">海报</th><th scope="col">名称</th><th scope="col">形态</th><th scope="col">状态</th><th scope="col" className="action-cell">可用操作</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.kind}:${row.id}`}>
        <td><Poster row={row} /></td><th scope="row">{row.name}</th><td>{row.kind === "movie" ? "电影" : "剧集"}</td>
        <td><span className={`status status--${row.status}`}>{statuses[row.status] ?? "未知状态"}</span></td>
        <td className="action-cell"><ActionButtons row={row} disabled={disabled} onAction={onAction} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
