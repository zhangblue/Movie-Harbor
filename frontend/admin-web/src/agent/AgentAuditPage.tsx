import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, listAgentAudit, listAgentAuditAccounts, type AgentAuditAccount, type AgentAuditDateRange, type AgentAuditHistory, type CaughtValue } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";

// 以角色和账号 ID 区分账号，用于导航选中状态及详情组件切换。
function accountKey(account: AgentAuditAccount) {
  return `${account.account_role}:${account.id}`;
}

// 将账号角色转换为后台显示标签。
function roleLabel(account: AgentAuditAccount) {
  return account.account_role === "admin" ? "管理员" : "普通用户";
}

// 草稿日期留在页面层，切换账号时可继续修改或应用。
interface DateFields { start: string; end: string }

// 已应用的可见日期和供接口使用的时间边界。
interface AppliedDates { fields: DateFields; range: AgentAuditDateRange }

// 按浏览器时区生成自然日边界，结束日使用次日零点以包含整天。
function toAuditRange(fields: DateFields): AgentAuditDateRange | undefined {
  const start = fields.start ? new Date(`${fields.start}T00:00:00`) : undefined;
  const end = fields.end ? new Date(`${fields.end}T00:00:00`) : undefined;
  end?.setHours(24, 0, 0, 0);
  if ([start, end].some((value) => value && Number.isNaN(value.getTime()))) return undefined;
  return { startAt: start?.toISOString(), endBefore: end?.toISOString() };
}

// 描述当前应用的范围，让输入框的未提交修改与实际结果分开显示。
function describeDates({ start, end }: DateFields): string {
  if (!end) return `自 ${start} 起`;
  return start ? `${start} 至 ${end}` : `截至 ${end}`;
}

// 管理员打开审阅页时加载账号汇总，右侧仅显示当前选中账号的对话。
export function AgentAuditPage({ onExpired }: { onExpired: () => void }) {
  const [accounts, setAccounts] = useState<AgentAuditAccount[]>();
  const [selection, setSelection] = useState<string>();
  const [draft, setDraft] = useState<DateFields>({ start: "", end: "" });
  const [applied, setApplied] = useState<AppliedDates>();
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
          <AccountHistory key={accountKey(selected)} account={selected} onExpired={onExpired}
            draft={draft} onDraft={setDraft} applied={applied} onApply={setApplied} />
        </div>}
  </section>;
}

// 浏览某个账号的问答，在打开详情或更改分页时读取对应页。
function AccountHistory({ account, onExpired, draft, onDraft, applied, onApply }: {
  account: AgentAuditAccount;
  onExpired: () => void;
  draft: DateFields;
  onDraft: (fields: DateFields) => void;
  applied?: AppliedDates;
  onApply: (dates?: AppliedDates) => void;
}) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [data, setData] = useState<AgentAuditHistory>();
  const [dateError, setDateError] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const cursor = pages.at(-1);
  const next = data?.next;

  // 分页或重试时只读取该账号，防止迟到响应覆盖当前页面。
  useEffect(() => {
    let ignore = false;
    setData(undefined);
    setError("");
    const request = applied ? listAgentAudit(account, cursor, applied.range) : listAgentAudit(account, cursor);
    void request.then((page) => {
      if (!ignore) setData(page);
    }).catch((cause: CaughtValue) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("未能读取对话记录。");
    });
    return () => { ignore = true; };
  }, [account, applied, cursor, revision, onExpired]);

  // 编辑只调整输入，点击筛选或清除才改变请求条件。
  function changeDate(field: keyof DateFields, value: string) {
    setDateError("");
    onDraft({ ...draft, [field]: value });
  }

  // 验证成功后与新日期一起重置游标，避免用旧页码查新范围。
  function applyDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.start && draft.end && draft.start > draft.end) {
      setDateError("开始日期不能晚于结束日期。");
      return;
    }
    const range = toAuditRange(draft);
    if (!range) {
      setDateError("请输入有效日期。");
      return;
    }
    setDateError("");
    setPages([undefined]);
    onApply(draft.start || draft.end ? { fields: draft, range } : undefined);
  }

  // 同时清除编辑值与已应用的筛选，并回到未筛选结果的第一页。
  function clearDates() {
    setDateError("");
    onDraft({ start: "", end: "" });
    setPages([undefined]);
    onApply(undefined);
  }

  return <section className="agent-audit-panel" aria-label={`${account.account}的对话`}>
    <header className="agent-audit-heading">
      <div><h2>{account.account}</h2><span>{roleLabel(account)}</span></div>
      <span aria-live="polite">{applied ? data?.total !== undefined && `匹配 ${data.total} 轮对话` : `${account.turn_count} 轮对话`}</span>
    </header>
    <form className="agent-audit-filter" aria-label="按日期筛选" onSubmit={applyDates}>
      <Field label="开始日期"><input type="date" value={draft.start} onChange={(event) => changeDate("start", event.target.value)} /></Field>
      <Field label="结束日期"><input type="date" value={draft.end} onChange={(event) => changeDate("end", event.target.value)} /></Field>
      <div className="agent-audit-filter-actions">
        <Button type="submit" variant="primary">筛选</Button>
        <Button type="button" onClick={clearDates} disabled={!draft.start && !draft.end && !applied}>清除</Button>
      </div>
      {dateError && <p role="alert" className="agent-audit-filter-error">{dateError}</p>}
    </form>
    {applied && <p className="agent-audit-date-range">{describeDates(applied.fields)}</p>}
    {error ? <p className="agent-audit-status" role="alert">{error} <Button onClick={() => setRevision((value) => value + 1)}>重试</Button></p>
      : !data ? <p className="agent-audit-status" role="status">正在读取对话记录…</p>
      : data.items.length === 0 ? <p className="agent-audit-status">{applied ? "所选日期范围内没有对话。" : "暂无对话记录。"}</p>
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
