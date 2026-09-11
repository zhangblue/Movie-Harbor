import { useCallback, useEffect, useState } from "react";
import { ApiError, clearCsrfToken, getSession, logout } from "@movie-harbor/api-client";
import { Button, Dialog } from "@movie-harbor/ui";
import { LoginPage } from "../auth/LoginPage";
import { AccountMenu } from "../auth/AccountMenu";
import { ChangePasswordDialog } from "../auth/ChangePasswordDialog";
import { ContentPage } from "../content/ContentPage";
import { MovieEditor } from "../movies/MovieEditor";
import { useMounted } from "./useMounted";
import "@movie-harbor/ui/theme.css";
import "../styles.css";

type Auth = { state: "loading" } | { state: "anonymous" } | { state: "error" } | { state: "authenticated"; name: string };
export function App() {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState("内容管理");
  const [pendingPage, setPendingPage] = useState("");
  const [moviePage, setMoviePage] = useState<{ id: string | null; deleting: boolean } | null>(null);
  const mounted = useMounted();

  const expire = useCallback((message = "会话已失效，请重新登录。") => {
    clearCsrfToken();
    setAuth({ state: "anonymous" });
    setPasswordOpen(false);
    setPendingPage("");
    setMoviePage(null);
    setSection("内容管理");
    setNotice(message);
  }, []);
  const onExpired = useCallback(() => expire(), [expire]);

  useEffect(() => {
    let ignore = false;
    setAuth({ state: "loading" });
    // Skip the discarded StrictMode setup before issuing a shared-client session request.
    void Promise.resolve().then(async () => {
      if (ignore) return;
      try {
        const session = await getSession();
        if (!ignore) setAuth({ state: "authenticated", name: session.name });
      } catch (cause) {
        if (ignore) return;
        if (cause instanceof ApiError && cause.status === 401) expire("");
        else setAuth({ state: "error" });
      }
    });
    return () => { ignore = true; };
  }, [attempt, expire]);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await logout();
      if (mounted.current) expire("已退出登录。");
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 401) expire();
      else {
        // logout clears the client token even on a transport error; recover it before more writes.
        try {
          await getSession();
          if (mounted.current) setError("退出登录失败，请重试。");
        } catch (sessionError) {
          if (mounted.current) {
            if (sessionError instanceof ApiError && sessionError.status === 401) expire("已退出登录。");
            else { setAuth({ state: "error" }); setPasswordOpen(false); }
          }
        }
      }
    } finally { if (mounted.current) setBusy(false); }
  }

  if (auth.state === "loading") return <main className="session-state"><p role="status">正在确认管理员会话…</p></main>;
  if (auth.state === "error") return <main className="session-state"><p role="alert">无法确认管理员会话，请检查网络后重试。</p><Button onClick={() => setAttempt(attempt + 1)}>重试</Button></main>;
  if (auth.state === "anonymous") return <LoginPage notice={notice} onLogin={(name) => { setError(""); setAuth({ state: "authenticated", name }); }} />;
  return <>
    <div className="admin-shell" inert={passwordOpen || !!pendingPage || busy}>
      <header className="admin-header"><a href="/" className="brand"><span className="brand-mark" aria-hidden="true">M</span>Movie Harbor<span className="admin-label">管理后台</span></a>
        <AccountMenu name={auth.name} onPassword={() => setPasswordOpen(true)} onLogout={() => { void signOut(); }} disabled={busy} />
      </header>
      <div className="admin-layout"><nav className="sidebar" aria-label="后台导航"><p className="eyebrow">工作台</p>
        {["内容管理", "题材配置", "系统设置"].map((label) => <button key={label} type="button" className="side-link" aria-current={section === label ? "page" : undefined} onClick={() => setSection(label)}>{label}</button>)}
      </nav><main className="admin-content">
        {error && <p role="alert" className="error-message">{error}</p>}
        {section === "内容管理" ? moviePage ? <MovieEditor key={moviePage.id ?? "new"} movieId={moviePage.id} initialDelete={moviePage.deleting} onBack={() => setMoviePage(null)} onExpired={onExpired} /> : <ContentPage onExpired={onExpired} onOpen={(row, action) => {
          if (!row || row.kind === "movie") { setMoviePage({ id: row?.id ?? null, deleting: action === "delete" }); return; }
          const labels = { create: "新建内容", edit: "编辑", view: "查看", delete: "永久删除" };
          setPendingPage(row ? `${labels[action]}：${row.name}` : labels[action]);
        }} /> : <section><h1>{section}</h1><p>此页面尚未开放。</p></section>}
      </main></div>
    </div>
    {busy && <p className="session-state" role="status">正在退出登录…</p>}
    {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} onChanged={() => expire("密码已修改，请重新登录。")} onExpired={onExpired} />}
    <Dialog open={!!pendingPage} title={pendingPage} onClose={() => setPendingPage("")}><p>内容编辑与删除确认页面尚未开放。</p><Button onClick={() => setPendingPage("")}>返回列表</Button></Dialog>
  </>;
}
