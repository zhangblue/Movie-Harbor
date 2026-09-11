import { useState, type FormEvent } from "react";
import { ApiError, changePassword, getSession } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "./recoverForbiddenWrite";

export function ChangePasswordDialog({ onClose, onChanged, onExpired }: {
  onClose: () => void; onChanged: () => void; onExpired: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError("两次输入的新密码不一致。"); return; }
    if (!password.trim()) { setError("新密码不能为空。"); return; }
    setError("");
    setBusy(true);
    try {
      await changePassword({ current_password: current, new_password: password });
      if (mounted.current) onChanged();
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 403) {
        const recovery = await recoverForbiddenWrite();
        if (!mounted.current) return;
        if (recovery.expired) onExpired();
        else setError(recovery.message);
      } else if (cause instanceof ApiError && cause.status === 401) {
        // A wrong current password and an expired session share HTTP 401 in the auth API.
        try {
          await getSession();
          if (mounted.current) setError("当前密码不正确，请重试。");
        } catch (sessionError) {
          if (mounted.current) {
            if (sessionError instanceof ApiError && sessionError.status === 401) onExpired();
            else setError("无法确认会话，请检查网络后重试。");
          }
        }
      } else setError("密码修改失败，请稍后重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <Dialog open title="修改密码" className="password-dialog" onClose={() => { if (!busy) onClose(); }}>
    <p>请输入当前密码。修改成功后，需要重新登录。</p>
    <form onSubmit={submit} aria-busy={busy}>
      <Field label="当前密码"><input type="password" required autoComplete="current-password" value={current} disabled={busy} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="新密码"><input type="password" required autoComplete="new-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="确认新密码"><input type="password" required autoComplete="new-password" value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} /></Field>
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="dialog-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "正在保存…" : "保存密码"}</Button></div>
    </form>
  </Dialog>;
}
