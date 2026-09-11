import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { apiRequest, clearCsrfToken } from "@movie-harbor/api-client";
import { App } from "./App";
import { deferred, json, server, session } from "../test/server";

afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Catches entering the admin shell before a verified session and losing the session request after login.
it("requires a session, exposes failed login, then acquires CSRF before entering the shell", async () => {
  let loggedIn = false;
  const requests = server((request) => {
    if (request.url === "/api/admin/session") return json(loggedIn ? session : { error: "authentication failed" }, loggedIn ? 200 : 401);
    if (request.url === "/api/admin/login") {
      loggedIn = (request.body as { password: string }).password === "correct-password";
      return json(loggedIn ? { name: session.name } : { error: "authentication failed" }, loggedIn ? 200 : 401);
    }
  });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  render(<App />);
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  await screen.findByRole("heading", { name: "管理员登录" });
  await user.type(screen.getByLabelText("管理员名称"), session.name);
  await user.type(screen.getByLabelText("密码", { exact: true }), "wrong");
  await user.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/名称或密码/);
  await user.clear(screen.getByLabelText("密码", { exact: true }));
  await user.type(screen.getByLabelText("密码", { exact: true }), "correct-password");
  await user.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByRole("heading", { name: "内容管理" });
  expect(screen.getByRole("button", { name: session.name })).toBeInTheDocument();
  expect(requests.filter((r) => r.url === "/api/admin/session")).toHaveLength(2);
  expect(requests.every((r) => r.credentials === "same-origin")).toBe(true);
  expect(storage).not.toHaveBeenCalled();
});

it("creates a genre from the genre configuration page", async () => {
  const genres: Array<{ id: string; name: string; sort_order: number; enabled: boolean }> = [];
  const requests = server((request) => {
    if (request.url === "/api/admin/genres" && request.method === "GET") return json(genres);
    if (request.url === "/api/admin/genres" && request.method === "POST") {
      const genre = { id: "genre-1", name: (request.body as { name: string }).name, sort_order: 1, enabled: true };
      genres.push(genre);
      return json(genre, 201);
    }
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "题材配置" }));
  await screen.findByRole("heading", { name: "题材配置" });
  await user.type(screen.getByLabelText("题材名称"), "纪录片");
  await user.click(screen.getByRole("button", { name: "新增题材" }));
  expect(await screen.findByDisplayValue("纪录片")).toBeInTheDocument();
  expect(requests.find((request) => request.method === "POST" && request.url === "/api/admin/genres")?.body).toEqual({ name: "纪录片" });
});

it("renames, reorders, deactivates, and deletes genres", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let genres = [
    { id: "g1", name: "剧情", sort_order: 1, enabled: true },
    { id: "g2", name: "科幻", sort_order: 2, enabled: true },
  ];
  const requests = server((request) => {
    if (request.url === "/api/admin/genres" && request.method === "GET") return json(genres);
    if (request.url === "/api/admin/genres/g2" && request.method === "PATCH") {
      genres = genres.map((genre) => genre.id === "g2" ? { ...genre, name: (request.body as { name: string }).name } : genre);
      return json(genres[1]);
    }
    if (request.url === "/api/admin/genres/order" && request.method === "PUT") {
      const positions = new Map((request.body as { items: Array<{ id: string; sort_order: number }> }).items.map((item) => [item.id, item.sort_order]));
      genres = genres.map((genre) => ({ ...genre, sort_order: positions.get(genre.id)! })).sort((a, b) => a.sort_order - b.sort_order);
      return json(genres);
    }
    if (request.url === "/api/admin/genres/g1/deactivate" && request.method === "POST") {
      genres = genres.map((genre) => genre.id === "g1" ? { ...genre, enabled: false } : genre);
      return json(genres.find((genre) => genre.id === "g1"));
    }
    if (request.url === "/api/admin/genres/g2" && request.method === "DELETE") {
      genres = genres.filter((genre) => genre.id !== "g2");
      return new Response(null, { status: 204 });
    }
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "题材配置" }));
  await user.clear(await screen.findByLabelText("编辑题材 科幻"));
  await user.type(screen.getByLabelText("编辑题材 科幻"), "太空歌剧");
  await user.click(screen.getByRole("button", { name: "保存 科幻" }));
  await screen.findByDisplayValue("太空歌剧");
  await user.click(screen.getByRole("button", { name: "上移 太空歌剧" }));
  await user.click(screen.getByRole("button", { name: "停用 剧情" }));
  expect(await screen.findByRole("row", { name: /剧情 停用/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "删除 太空歌剧" }));
  expect(screen.queryByDisplayValue("太空歌剧")).not.toBeInTheDocument();
  expect(requests.some((request) => request.url.endsWith("/order") && request.method === "PUT")).toBe(true);
});

// Catches menu focus/closure regressions that leave controls inaccessible to keyboard users.
it("opens the account menu by keyboard and closes on Escape and outside click", async () => {
  server();
  const user = userEvent.setup();
  render(<App />);
  const account = await screen.findByRole("button", { name: session.name });
  account.focus();
  await user.keyboard("{Enter}");
  expect(account).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menuitem", { name: "修改密码" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "退出登录" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(account).toHaveFocus();
  await user.click(account);
  await user.click(screen.getByRole("heading", { name: "内容管理" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(within(screen.getByRole("navigation")).queryByText("退出登录")).not.toBeInTheDocument();
});

// Catches missing current-password verification payload, CSRF attachment, and retained credentials.
it("changes the password with CSRF and returns to login with the token cleared", async () => {
  const requests = server((r) => r.url === "/api/admin/password" || r.url === "/api/admin/probe" ? new Response(null, { status: 204 }) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "修改密码" }));
  const dialog = screen.getByRole("dialog", { name: "修改密码" });
  await user.type(within(dialog).getByLabelText("当前密码"), "old-password");
  await user.type(within(dialog).getByLabelText("新密码", { exact: true }), "new-password");
  await user.type(within(dialog).getByLabelText("确认新密码"), "different");
  await user.click(within(dialog).getByRole("button", { name: "保存密码" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent(/不一致/);
  expect(requests.some((r) => r.url === "/api/admin/password")).toBe(false);
  await user.clear(within(dialog).getByLabelText("确认新密码"));
  await user.type(within(dialog).getByLabelText("确认新密码"), "new-password");
  await user.click(within(dialog).getByRole("button", { name: "保存密码" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.getByRole("status")).toHaveTextContent(/密码.*重新登录/);
  const mutation = requests.find((r) => r.url === "/api/admin/password")!;
  expect(mutation.body).toEqual({ current_password: "old-password", new_password: "new-password" });
  expect(mutation.headers.get("X-CSRF-Token")).toBe("session-csrf");
  await apiRequest("/api/admin/probe", { method: "POST" });
  expect(requests.at(-1)!.headers.has("X-CSRF-Token")).toBe(false);
});

it("keeps wrong-current-password feedback in the dialog when the session remains valid", async () => {
  server((r) => r.url === "/api/admin/password" ? json({ error: "authentication failed" }, 401) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "修改密码" }));
  await user.type(screen.getByLabelText("当前密码"), "wrong");
  await user.type(screen.getByLabelText("新密码", { exact: true }), "new-password");
  await user.type(screen.getByLabelText("确认新密码"), "new-password");
  await user.click(screen.getByRole("button", { name: "保存密码" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/当前密码/);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("logs out with the session CSRF and clears the shell", async () => {
  const requests = server((r) => r.url === "/api/admin/logout" ? new Response(null, { status: 204 }) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(requests.find((r) => r.url === "/api/admin/logout")!.headers.get("X-CSRF-Token")).toBe("session-csrf");
});

it("offers retry for session network failure instead of pretending the user is logged out", async () => {
  let unavailable = true;
  server((r) => {
    if (r.url === "/api/admin/session" && unavailable) return Promise.reject(new TypeError("offline"));
  });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/会话/);
  expect(screen.queryByRole("heading", { name: "管理员登录" })).not.toBeInTheDocument();
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("heading", { name: "内容管理" });
});

it("does not restore an unmounted login after a delayed response", async () => {
  const pending = deferred<Response>();
  const requests = server((r) => r.url === "/api/admin/session" ? json({ error: "authentication failed" }, 401) : r.url === "/api/admin/login" ? pending.promise : undefined);
  const user = userEvent.setup();
  const view = render(<App />);
  await screen.findByRole("heading", { name: "管理员登录" });
  await user.type(screen.getByLabelText("管理员名称"), "admin");
  await user.type(screen.getByLabelText("密码", { exact: true }), "password");
  await user.click(screen.getByRole("button", { name: "登录" }));
  view.unmount();
  await act(async () => { pending.resolve(json({ name: "admin" })); });
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(requests.filter((r) => r.url === "/api/admin/session")).toHaveLength(1);
});

it("recovers the CSRF token after failed logout so a retry can revoke the session", async () => {
  let attempts = 0;
  const requests = server((r) => {
    if (r.url === "/api/admin/logout") return ++attempts === 1 ? Promise.reject(new TypeError("offline")) : new Response(null, { status: 204 });
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/退出登录失败/);
  await user.click(screen.getByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  const writes = requests.filter((r) => r.url === "/api/admin/logout");
  expect(writes).toHaveLength(2);
  expect(writes.every((r) => r.headers.get("X-CSRF-Token") === "session-csrf")).toBe(true);
});

// A server may revoke a session before its logout response is lost on the network.
it("returns to login when logout loses its response but session recovery confirms revocation", async () => {
  let revoked = false;
  server((r) => {
    if (r.url === "/api/admin/logout") { revoked = true; return Promise.reject(new TypeError("connection lost")); }
    if (r.url === "/api/admin/session" && revoked) return json({ error: "authentication failed" }, 401);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

it("refreshes stale CSRF for password changes without automatically resubmitting the password", async () => {
  let token = session.csrf_token;
  const requests = server((r) => {
    if (r.url === "/api/admin/session") return json({ ...session, csrf_token: token });
    if (r.url === "/api/admin/password") return r.headers.get("X-CSRF-Token") === token
      ? new Response(null, { status: 204 }) : json({ error: "request forbidden" }, 403);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: session.name }));
  await user.click(screen.getByRole("menuitem", { name: "修改密码" }));
  await user.type(screen.getByLabelText("当前密码"), "old-password");
  await user.type(screen.getByLabelText("新密码"), "new-password");
  await user.type(screen.getByLabelText("确认新密码"), "new-password");
  token = "renewed-csrf";
  await user.click(screen.getByRole("button", { name: "保存密码" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/重新确认会话.*重新执行/);
  expect(requests.filter((r) => r.url === "/api/admin/password")).toHaveLength(1);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存密码" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(requests.filter((r) => r.url === "/api/admin/password").map((r) => r.headers.get("X-CSRF-Token"))).toEqual(["session-csrf", "renewed-csrf"]);
});

it.each([
  ["lifecycle", 401], ["password", 401], ["lifecycle", 503], ["password", 503],
])("handles %s write 403 followed by session recovery %s without replaying it", async (action, recoveryStatus) => {
  let forbidden = false;
  const endpoint = action === "password" ? "/api/admin/password" : "/api/admin/series/series-1/archive";
  const requests = server((r) => {
    if (r.url === endpoint) { forbidden = true; return json({ error: "request forbidden" }, 403); }
    if (r.url === "/api/admin/session" && forbidden) return json({ error: "session unavailable" }, Number(recoveryStatus));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("长夜航线");
  if (action === "password") {
    await user.click(screen.getByRole("button", { name: session.name }));
    await user.click(screen.getByRole("menuitem", { name: "修改密码" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.type(screen.getByLabelText("确认新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存密码" }));
  } else await user.click(screen.getByRole("button", { name: "归档" }));
  if (recoveryStatus === 401) {
    await screen.findByRole("heading", { name: "管理员登录" });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  } else {
    expect(await screen.findByRole("alert")).toHaveTextContent(/无法确认会话/);
    expect(screen.getByRole("button", { name: action === "password" ? "保存密码" : "归档" })).toBeEnabled();
  }
  expect(requests.filter((r) => r.url === endpoint)).toHaveLength(1);
});
