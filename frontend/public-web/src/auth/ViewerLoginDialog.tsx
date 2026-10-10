import { useState, type FormEvent } from "react";
import { ApiError, viewerLogin, type ViewerSessionResponse } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";

export function ViewerLoginDialog({ onClose, onLogin }: { onClose: () => void; onLogin: (session: ViewerSessionResponse) => boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    try { await viewerLogin({ username, password }, onLogin); }
    catch (cause) {
      setError(cause instanceof ApiError && [400, 401].includes(cause.status)
        ? "用户名或密码错误" : "登录失败，请稍后重试。");
    } finally { setPending(false); }
  }
  return <Dialog open title="登录" className="viewer-dialog" onClose={() => { if (!pending) onClose(); }}>
    <p className="viewer-dialog-description">登录后可浏览和播放私密影片。</p>
    <form onSubmit={submit}>
      <Field label="用户名"><input required autoComplete="username" value={username} disabled={pending} onChange={(event) => setUsername(event.target.value)} /></Field>
      <Field label="密码"><input required type="password" autoComplete="current-password" value={password} disabled={pending} onChange={(event) => setPassword(event.target.value)} /></Field>
      {error && <p role="alert" className="viewer-error">{error}</p>}
      <div className="viewer-dialog-actions"><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={pending}>{pending ? "正在登录…" : "登录"}</Button></div>
    </form>
  </Dialog>;
}
