import { useRef, useState, type FormEvent } from "react";
import { ApiError, changeViewerUserPassword, createViewerUser, deleteViewerUser, type ViewerUserSummary } from "@movie-harbor/api-client";
import { Button, Dialog, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";
import { recoverForbiddenWrite } from "../auth/recoverForbiddenWrite";

export type UserOperation = { mode: "create" } | { mode: "password" | "delete"; user: ViewerUserSummary };

export function UserDialog({ operation, onClose, onDone, onReload, onExpired }: {
  operation: UserOperation; onClose: () => void; onDone: (message: string) => void; onReload: () => void; onExpired: () => void;
}) {
  const [username, setUsername] = useState(operation.mode === "create" ? "" : operation.user.username);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const mounted = useMounted();
  const deleting = operation.mode === "delete";
  const creating = operation.mode === "create";
  const title = creating ? "添加用户" : deleting ? "删除用户？" : "修改密码";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || conflict) return;
    if (!deleting && (!password.trim() || Array.from(password).length < 8)) { setError("密码至少需要 8 个字符。"); return; }
    if (creating && !username.trim()) { setError("请输入用户名。"); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (operation.mode === "create") await createViewerUser({ username: username.trim(), password });
      else if (operation.mode === "password") await changeViewerUserPassword(operation.user.id, { version: operation.user.version, new_password: password });
      else await deleteViewerUser(operation.user.id, operation.user.version);
      if (mounted.current) onDone(creating ? "用户已添加。" : deleting ? "用户已删除。" : "密码已修改，该用户现有的登录会话已失效。");
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else if (cause instanceof ApiError && cause.status === 403) {
        const recovery = await recoverForbiddenWrite();
        if (!mounted.current) return;
        if (recovery.expired) onExpired();
        else setError(recovery.message);
      } else if (cause instanceof ApiError && cause.status === 409) {
        if (creating) setError("用户名已存在，用户名不区分大小写，请使用其他名称。");
        else { setConflict(true); setError("用户已发生变化，请重新加载后重试。"); }
      } else if (cause instanceof ApiError && cause.status === 404) {
        setConflict(true);
        setError("用户已不存在，请重新加载列表。");
      } else if (cause instanceof ApiError && cause.status === 400) setError(cause.message);
      else if (cause instanceof ApiError && cause.status === 422) setError(`输入不符合要求：${cause.message}`);
      else setError("操作失败，请检查网络后重试。");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Dialog open title={title} className={`user-dialog${deleting ? " user-delete-dialog" : ""}`} onClose={() => { if (!pending.current) onClose(); }}>
    {!deleting && <p className="eyebrow">{creating ? "NEW USER" : "CHANGE PASSWORD"}</p>}
    {deleting ? <p>用户 <strong>{username}</strong> 将无法再登录，现有会话也会立即失效。此操作不可撤销。</p> : <p>{creating ? "创建普通用户，并为其设置初始登录密码。用户名创建后不可修改，且不区分大小写。" : "设置新密码后，该用户现有的登录会话会立即失效。"}</p>}
    <form onSubmit={submit} aria-busy={busy}>
      {!deleting && <>
        <Field label="用户名"><input required maxLength={100} autoComplete="off" value={username} disabled={!creating || busy || conflict} onChange={(event) => setUsername(event.target.value)} /></Field>
        <Field label={creating ? "初始密码" : "新密码"}><input type="password" required minLength={8} autoComplete="new-password" value={password} disabled={busy || conflict} onChange={(event) => setPassword(event.target.value)} /></Field>
        <small className="user-password-hint">密码至少 8 个字符。</small>
      </>}
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="dialog-actions"><Button disabled={busy} onClick={onClose}>取消</Button>{conflict ? <Button onClick={onReload}>重新加载</Button> : null}<Button type="submit" variant={deleting ? "danger" : "primary"} disabled={busy || conflict}>{busy ? "正在保存…" : creating ? "创建用户" : deleting ? "确认删除" : "保存新密码"}</Button></div>
    </form>
  </Dialog>;
}
