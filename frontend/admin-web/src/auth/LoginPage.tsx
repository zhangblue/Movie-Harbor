import { useState, type FormEvent } from "react";
import { ApiError, getSession, login } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";
import { useMounted } from "../app/useMounted";

export function LoginPage({ onLogin, notice }: { onLogin: (name: string) => void; notice: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await login({ name: name.trim(), password });
      if (!mounted.current) return;
      const session = await getSession();
      if (mounted.current) onLogin(session.name);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError && cause.status === 401 ? "管理员名称或密码不正确，请重试。"
        : cause instanceof ApiError && cause.status === 429 ? "登录尝试过于频繁，请稍后重试。"
          : "登录失败，请检查网络后重试。");
    } finally {
      if (mounted.current) { setBusy(false); setPassword(""); }
    }
  }

  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <a className="brand" href="/">Movie Harbor</a>
      <h1 id="login-title">管理员登录</h1>
      <p>登录后管理电影、剧集与媒体内容。</p>
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={submit} aria-busy={busy}>
        <Field label="管理员名称"><input required autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></Field>
        <Field label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></Field>
        {error && <p className="error-message" role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "正在登录…" : "登录"}</Button>
      </form>
    </section>
  </main>;
}
