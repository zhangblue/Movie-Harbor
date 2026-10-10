import { useEffect, useState, type FormEvent } from "react";
import { ApiError, listViewerUsers, type ViewerUserPage, type ViewerUserSummary } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";
import { ContentPagination } from "../content/ContentPagination";
import { UserDialog, type UserOperation } from "./UserDialog";
import { trimViewerWhitespace } from "./userInput";

function dateLabel(value: string | null) {
  if (!value) return "从未登录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function UserPage({ onExpired }: { onExpired: () => void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ViewerUserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<UserOperation | null>(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    void listViewerUsers({ q: search || undefined, page, size: 20 }).then((result) => {
      if (ignore) return;
      const lastPage = Math.max(1, Math.ceil(result.total / 20));
      if (page > lastPage) { setPage(lastPage); return; }
      setData(result);
    }).catch((cause) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("用户列表加载失败，请重新加载。");
    }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [search, page, revision, onExpired]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setSearch(trimViewerWhitespace(query));
    setPage(1);
    setRevision((value) => value + 1);
    setNotice("");
  }
  function open(mode: "password" | "delete", user: ViewerUserSummary) {
    setNotice("");
    setOperation({ mode, user });
  }

  return <>
    <section inert={operation !== null}>
      <div className="admin-title-row users-title-row"><div><p className="eyebrow">VIEWER ACCOUNTS</p><h1>用户管理</h1><p className="title-description">管理可在公开站登录并查看私密影片的普通用户。</p></div>
        <Button variant="primary" disabled={loading || !!error} onClick={() => { setNotice(""); setOperation({ mode: "create" }); }}>＋ 添加用户</Button>
      </div>
      {data && <section className="user-summary" aria-label="用户概览">
        <article><span>普通用户</span><strong>{data.summary.total_users}</strong><small>全部可查看已发布私密内容</small></article>
        <article><span>当前有会话</span><strong>{data.summary.active_users}</strong><small>修改密码后相关会话立即失效</small></article>
        <article><span>最近添加</span><strong>{data.summary.latest_user?.username ?? "暂无用户"}</strong><small>{data.summary.latest_user ? `${dateLabel(data.summary.latest_user.created_at)} 创建` : "添加用户后即可登录公开站"}</small></article>
      </section>}
      <form className="user-toolbar" role="search" onSubmit={submitSearch}>
        <div className="user-search-controls"><label className="user-search"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z" /></svg><input type="search" aria-label="搜索用户名" placeholder="搜索用户名" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} /></label><Button type="submit" disabled={loading}>查询</Button></div>
        {data && <span>共 {data.total} 位用户</span>}
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && <div className="request-error"><p role="alert">{error}</p><Button disabled={loading} onClick={() => setRevision((value) => value + 1)}>重新加载</Button></div>}
      {loading && <p role="status">正在加载用户…</p>}
      {data && <div className="table-card"><table className="content-table user-table"><thead><tr><th scope="col">用户</th><th scope="col" className="user-time">创建时间</th><th scope="col" className="user-time">最近登录</th><th scope="col" className="action-cell">操作</th></tr></thead><tbody>
        {data.items.map((user) => <tr key={user.id}>
          <th scope="row"><div className="user-identity"><span className="user-avatar" aria-hidden="true">{Array.from(user.username).slice(0, 2).join("")}</span><div><strong>{user.username}</strong><span className={`user-session${user.has_active_session ? "" : " offline"}`}>{user.has_active_session ? "当前有会话" : "暂无会话"}</span></div></div></th>
          <td className="user-time user-meta">{dateLabel(user.created_at)}</td><td className="user-time user-meta">{dateLabel(user.last_login_at)}</td>
          <td className="action-cell"><div className="row-actions"><Button compact disabled={loading || !!error} onClick={() => open("password", user)}>修改密码</Button><Button compact variant="danger" disabled={loading || !!error} onClick={() => open("delete", user)}>删除</Button></div></td>
        </tr>)}
      </tbody></table>
        {!loading && !error && data.items.length === 0 && <div className="empty-state" role="status"><strong>{search ? "没有找到匹配用户" : "尚无普通用户"}</strong><p>{search ? "请检查用户名后再试。" : "添加用户后，即可在公开站登录并查看私密影片。"}</p></div>}
      </div>}
      <div className="content-pagination-slot">{data && <ContentPagination page={data.page} size={20} total={data.total} disabled={loading} onPage={setPage} />}</div>
    </section>
    {operation && <UserDialog operation={operation} onExpired={onExpired} onClose={() => setOperation(null)} onReload={() => { setOperation(null); setRevision((value) => value + 1); }} onDone={(message) => { setOperation(null); setNotice(message); setRevision((value) => value + 1); }} />}
  </>;
}
