import { useState, type FormEvent } from "react";
import { ApiError, changeViewerPassword } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useViewer } from "./ViewerContext";

export function ViewerPasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { expire } = useViewer();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (Array.from(newPassword).length < 8) { setError("新密码至少需要 8 个字符"); return; }
    setPending(true); setError("");
    try { await changeViewerPassword({ current_password: currentPassword, new_password: newPassword }); onChanged(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) expire();
      else setError(cause instanceof ApiError && cause.status === 400 ? cause.message : "密码修改失败，请稍后重试。");
    } finally { setPending(false); }
  }
  return <Dialog open title="修改密码" className="viewer-dialog" onClose={() => { if (!pending) onClose(); }}>
    <p className="viewer-dialog-description">修改成功后，所有设备都会退出登录，请使用新密码重新登录。</p>
    <form onSubmit={submit}>
      <Field label="当前密码"><input required type="password" autoComplete="current-password" value={currentPassword} disabled={pending} onChange={(event) => setCurrentPassword(event.target.value)} /></Field>
      <Field label="新密码" helpText="至少 8 个字符"><input required type="password" autoComplete="new-password" value={newPassword} disabled={pending} onChange={(event) => setNewPassword(event.target.value)} /></Field>
      {error && <p role="alert" className="viewer-error">{error}</p>}
      <div className="viewer-dialog-actions"><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={pending}>{pending ? "正在保存…" : "保存新密码"}</Button></div>
    </form>
  </Dialog>;
}
