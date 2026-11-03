import { useState, type FormEvent } from "react";
import { ApiError, changeViewerPassword } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useViewer } from "./ViewerContext";

// 由应用在用户修改密码时渲染表单并协调会话失效。
export function ViewerPasswordDialog({ onClose, onChanged, isCurrent }: { onClose: () => void; onChanged: () => void; isCurrent: () => boolean }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { expire } = useViewer();
  // 提交普通用户改密表单时校验长度、阻止重复请求并处理身份变化。
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (Array.from(newPassword).length < 8) { setError("新密码至少需要 8 个字符"); return; }
    setPending(true); setError("");
    try {
      await changeViewerPassword({ current_password: currentPassword, new_password: newPassword }, isCurrent);
      // 改密撤销原会话；仅在身份未切换时通知根组件退出登录。
      if (isCurrent()) onChanged();
    }
    catch (cause) {
      if (!isCurrent()) return;
      // 401 关闭已失效的会话；其他失败留在表单中供用户修正或重试。
      if (cause instanceof ApiError && cause.status === 401) expire();
      else setError(cause instanceof ApiError && cause.status === 400 ? cause.message : "密码修改失败，请稍后重试。");
    } finally { if (isCurrent()) setPending(false); }
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
