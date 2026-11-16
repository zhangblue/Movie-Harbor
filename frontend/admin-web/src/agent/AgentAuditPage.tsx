import { useEffect, useId, useState } from "react";
import { ApiError, listAgentAudit, listAgentAuditAccounts, type AgentAuditAccount, type AgentHistory, type CaughtValue } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";

// 以角色和账号 ID 区分账号，用于导航选中状态及详情组件切换。
function accountKey(account: AgentAuditAccount) {
  return `${account.account_role}:${account.id}`;
}

// 将账号角色转换为后台显示标签。
function roleLabel(account: AgentAuditAccount) {
  return account.account_role === "admin" ? "管理员" : "普通用户";
}

// 管理员打开审阅页时加载账号汇总，右侧仅显示当前选中账号的对话。
export function AgentAuditPage({ onExpired }: { onExpired: () => void }) {
  const [accounts, setAccounts] = useState<AgentAuditAccount[]>();
  const [selection, setSelection] = useState<string>();
  const [accountsCollapsed, setAccountsCollapsed] = useState(false);
  const accountsListId = useId();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const selected = accounts?.find((account) => accountKey(account) === selection) ?? accounts?.[0];

  // 打开页面或重试时请求摘要，离开页面后忽略本次响应。
  useEffect(() => {
    let ignore = false;
    setError("");
    void listAgentAuditAccounts().then((result) => {
      if (!ignore) setAccounts(result);
    }).catch((cause: CaughtValue) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("未能读取对话账号。");
    });
    return () => { ignore = true; };
  }, [revision, onExpired]);

  return <section className="agent-audit">
    <h1>助手对话记录</h1>
    {error ? <p role="alert">{error} <Button onClick={() => setRevision((value) => value + 1)}>重试</Button></p>
      : !accounts ? <p role="status">正在读取对话账号…</p>
      : !selected ? <p>暂无对话记录。</p>
      : <div className={`agent-audit-grid${accountsCollapsed ? " agent-audit-grid--collapsed" : ""}`}>
          <section className="agent-audit-panel" aria-label="对话账号">
            <header className="agent-audit-heading agent-audit-account-heading">
              {!accountsCollapsed && <><h2>用户</h2><span>{accounts.length} 个账号</span></>}
              {/* 折叠仅影响左栏布局，右侧详情与分页状态保持原样。 */}
              <button type="button" className="agent-audit-toggle"
                aria-expanded={!accountsCollapsed} aria-controls={accountsListId}
                aria-label={accountsCollapsed ? "展开用户列表" : "收起用户列表"}
                title={accountsCollapsed ? "展开用户列表" : "收起用户列表"}
                onClick={() => setAccountsCollapsed((collapsed) => !collapsed)}>
                <span aria-hidden="true">{accountsCollapsed ? "›" : "‹"}</span>
              </button>
            </header>
            <ul id={accountsListId} className="agent-audit-accounts" hidden={accountsCollapsed}>
              {accounts.map((account) => <li key={accountKey(account)}>
                <button type="button" aria-pressed={accountKey(selected) === accountKey(account)}
                  onClick={() => setSelection(accountKey(account))}>
                  <strong>{account.account}</strong><small>{roleLabel(account)}</small><span>{account.turn_count} 轮</span>
                </button>
              </li>)}
            </ul>
          </section>
          {/* 切换账号时重建详情，让上一账号的分页与数据立即清空。 */}
          <AccountHistory key={accountKey(selected)} account={selected} onExpired={onExpired} />
        </div>}
  </section>;
}

// 浏览某个账号的问答，在打开详情或更改分页时读取对应页。
function AccountHistory({ account, onExpired }: { account: AgentAuditAccount; onExpired: () => void }) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [data, setData] = useState<AgentHistory>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const cursor = pages.at(-1);
  const next = data?.next;

  // 分页或重试时只读取该账号，防止迟到响应覆盖当前页面。
  useEffect(() => {
    let ignore = false;
    setData(undefined);
    setError("");
    void listAgentAudit(account, cursor).then((page) => {
      if (!ignore) setData(page);
    }).catch((cause: CaughtValue) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("未能读取对话记录。");
    });
    return () => { ignore = true; };
  }, [account, cursor, revision, onExpired]);

  return <section className="agent-audit-panel" aria-label={`${account.account}的对话`}>
    <header className="agent-audit-heading">
      <div><h2>{account.account}</h2><span>{roleLabel(account)}</span></div>
      <span>{account.turn_count} 轮对话</span>
    </header>
    {error ? <p className="agent-audit-status" role="alert">{error} <Button onClick={() => setRevision((value) => value + 1)}>重试</Button></p>
      : !data ? <p className="agent-audit-status" role="status">正在读取对话记录…</p>
      : data.items.length === 0 ? <p className="agent-audit-status">暂无对话记录。</p>
      : <ol className="agent-audit-list">{data.items.map((turn) => <li key={turn.id}>
          <time dateTime={turn.created_at}>{new Date(turn.created_at).toLocaleString("zh-CN")}</time>
          <p><strong>用户</strong> {turn.prompt}</p>
          <p><strong>助手</strong> {turn.reply}</p>
        </li>)}</ol>}
    <nav aria-label="对话记录分页">
      <span aria-live="polite">第 {pages.length} 页</span>
      <Button disabled={pages.length <= 1} onClick={() => setPages((current) => current.slice(0, -1))}>上一页</Button>
      <Button disabled={!next} onClick={() => { if (next) setPages((current) => [...current, next]); }}>下一页</Button>
    </nav>
  </section>;
}
