import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, chatWithAgent, listAgentHistory, normalizeError, type AgentAccountRole, type AgentDraft, type AgentTurn, type CaughtValue } from "@movie-harbor/api-client";
import { Button } from "./Button";
import { AgentWindow } from "./AgentWindow";
import { Field } from "./Field";

// 定义页头入口需要的会话及管理员草稿处理回调。
interface AgentLauncherProps {
  role: AgentAccountRole;
  onExpired: () => void;
  onConfirmDraft?: (draft: AgentDraft) => Promise<void>;
  enabled?: boolean;
  sessionKey?: number;
  renderTrigger?: (trigger: ReactNode) => ReactNode;
}

// 提供登录后页头的助手入口，在打开时挂载浮层及独立会话界面。
export function AgentLauncher(props: AgentLauncherProps) {
  const [opened, setOpened] = useState<{ sessionKey?: number }>();
  const enabled = props.enabled ?? true;
  const open = enabled && Boolean(opened && opened.sessionKey === props.sessionKey);
  const trigger = enabled ? <button className="mh-agent-trigger" type="button" aria-label="影片助手" aria-haspopup="dialog"
      aria-expanded={open} title="影片助手" onClick={() => setOpened(open ? undefined : { sessionKey: props.sessionKey })}>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v3m-2-3h2m-8 7H2m20 0h-2" />
        <path d="M7 6h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5l-4 3v-3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" />
        <path d="M9 11v1m6-1v1" />
      </svg>
    </button> : undefined;
  return <>
    {props.renderTrigger ? props.renderTrigger(trigger) : trigger}
    {open && <AgentWindow onClose={() => setOpened(undefined)}><AgentChat {...props} /></AgentWindow>}
  </>;
}

// 显示当前账号问答、输入和待处理操作，供浮层打开期间使用。
function AgentChat({ role, onExpired, onConfirmDraft }: AgentLauncherProps) {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<AgentDraft>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollToLatest = useRef(true);

  // 浮层打开时恢复历史，卸载后的旧响应不得影响当前会话。
  useEffect(() => {
    let ignore = false;
    active.current = true;
    // 读取账号历史成功后才开放输入，避免恢复结果覆盖刚发送的问答。
    void listAgentHistory(role).then((page) => {
      if (ignore) return;
      setTurns(page.items);
      setNext(page.next);
    }).catch((cause: CaughtValue) => {
      if (ignore) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("对话记录未能加载，关闭后可重新打开。");
    }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; active.current = false; };
  }, [role, onExpired]);

  // 发送或首次恢复时滚到最新消息，翻阅旧记录时保留阅读位置。
  useEffect(() => {
    if (scrollToLatest.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns]);

  // 将会话失效交给应用处理，避免保留过期用户的聊天内容。
  function showError(cause: Error, fallback: string) {
    if (!active.current) return;
    if (cause instanceof ApiError && cause.status === 401) onExpired();
    else if (cause instanceof ApiError && cause.status === 503) setError("影片助手暂不可用，请稍后再试。");
    else setError(fallback);
  }

  // 翻阅旧对话时继续读取当前账号的下一页。
  async function loadOlder() {
    if (!next || busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await listAgentHistory(role, next);
      scrollToLatest.current = false;
      setTurns((current) => [...current, ...page.items]);
      setNext(page.next);
    } catch (cause) {
      showError(normalizeError(cause as CaughtValue), "未能加载更早的对话。");
    } finally { setBusy(false); }
  }

  // 发送当前输入，服务端保存后再把这一轮显示到聊天末尾。
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = input.trim();
    if (loading || busy || !prompt) return;
    setBusy(true);
    setDraft(undefined);
    setError("");
    setNotice("");
    try {
      const result = await chatWithAgent(role, prompt);
      scrollToLatest.current = true;
      setTurns((current) => [{
        id: result.id, account: "", account_role: role, prompt, reply: result.reply, created_at: "",
      }, ...current]);
      setDraft(onConfirmDraft ? result.draft : undefined);
      setInput("");
    } catch (cause) {
      showError(normalizeError(cause as CaughtValue), "未能取得回复，请稍后重试。");
    } finally { setBusy(false); }
  }

  // 在管理员点击明确的确认按钮后执行网站写入。
  async function confirm() {
    if (!draft || !onConfirmDraft || busy) return;
    setBusy(true);
    setError("");
    setDraft(undefined);
    try {
      await onConfirmDraft(draft);
      setNotice(`已创建${draft.kind === "movie" ? "电影" : "剧集"}草稿《${draft.name}》。`);
    } catch (cause) {
      showError(normalizeError(cause as CaughtValue), "无法确认草稿是否创建成功，请在内容管理中检查。");
    } finally { setBusy(false); }
  }

  return <>
    <p className="mh-agent-disclosure">你输入的消息会发给 DeepSeek。查询名单或数量时，匹配的公开或私密片名也会发送。对话保存在你的账号，管理员可以查看。</p>
    <div className="mh-agent-history" ref={scroll} role="log" aria-label="对话">
      {next && <Button type="button" disabled={busy} onClick={() => { void loadOlder(); }}>更早的对话</Button>}
      {!loading && turns.length === 0 && <p>可以问我「片库里有哪些影片？」</p>}
      {turns.slice().reverse().map((turn) => <article key={turn.id} className="mh-agent-turn">
        <p className="mh-agent-question"><strong>你</strong><span>{turn.prompt}</span></p>
        <p><strong>影片助手</strong><span>{turn.reply}</span></p>
      </article>)}
    </div>
    {draft && <section className="mh-agent-action">
      <p>新建{draft.kind === "movie" ? "电影" : "剧集"}草稿《{draft.name}》</p>
      <Button type="button" disabled={busy} onClick={() => { void confirm(); }}>确认创建草稿</Button>
      <Button type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消</Button>
    </section>}
    {notice && <p role="status">{notice}</p>}
    {(busy || loading) && <p role="status">{loading ? "正在载入对话…" : "正在处理…"}</p>}
    {error && <p role="alert">{error}</p>}
    <form className="mh-agent-form" onSubmit={(event) => { void send(event); }}>
      <Field label="消息"><textarea rows={2} maxLength={2000} value={input} disabled={busy || loading}
        onChange={(event) => setInput(event.target.value)} /></Field>
      <Button variant="primary" type="submit" disabled={busy || loading || !input.trim()}>发送</Button>
    </form>
  </>;
}
